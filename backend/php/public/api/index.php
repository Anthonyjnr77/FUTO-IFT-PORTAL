<?php
declare(strict_types=1);

$composerAutoload = dirname(__DIR__, 2) . '/vendor/autoload.php';
if (is_file($composerAutoload)) {
    require_once $composerAutoload;
}

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: ' . (getenv('CLIENT_URL') ?: '*'));
header('Vary: Origin');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');

function respond(int $status, array $body): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function uuid_v4(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    $hex = bin2hex($bytes);
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20);
}

function db_connection(): PDO
{
    $host = getenv('DB_HOST') ?: '';
    $name = getenv('DB_DATABASE') ?: '';
    $username = getenv('DB_USERNAME') ?: '';
    $password = getenv('DB_PASSWORD') ?: '';
    if ($host === '' || $name === '' || $username === '') {
        throw new RuntimeException('MySQL is not configured. Set DB_HOST, DB_DATABASE, DB_USERNAME, and DB_PASSWORD.');
    }
    $port = getenv('DB_PORT') ?: '3306';
    $dsn = 'mysql:host=' . $host . ';port=' . $port . ';dbname=' . $name . ';charset=utf8mb4';
    return new PDO($dsn, $username, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false
    ]);
}

function public_user(array $user): array
{
    return [
        'id' => $user['id'],
        'identifier' => $user['identifier'],
        'email' => $user['email'],
        'name' => $user['name'],
        'role' => $user['role'],
        'dept' => $user['dept'],
        'level' => $user['level'],
        'isActive' => (bool)$user['is_active'],
        'createdAt' => iso_time($user['created_at'])
    ];
}

function provision_initial_admin(PDO $db): void
{
    $username = strtolower(trim(getenv('ADMIN_USERNAME') ?: ''));
    $password = getenv('ADMIN_PASSWORD') ?: '';
    if ($username === '' && $password === '') {
        return;
    }
    if (strlen($username) < 3 || strlen($password) < 12) {
        throw new RuntimeException('Set ADMIN_USERNAME (at least 3 characters) and ADMIN_PASSWORD (at least 12 characters).');
    }
    $check = $db->prepare('SELECT id FROM users WHERE role = ? AND identifier = ? LIMIT 1');
    $check->execute(['admin', $username]);
    if ($check->fetch()) {
        return;
    }
    $email = strtolower(trim(getenv('ADMIN_EMAIL') ?: ''));
    if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        throw new RuntimeException('ADMIN_EMAIL must be a valid email address.');
    }
    $check = $db->prepare('SELECT id FROM users WHERE identifier = ? OR (? <> "" AND email = ?) LIMIT 1');
    $check->execute([$username, $email, $email]);
    if ($check->fetch()) {
        throw new RuntimeException('The configured administrator username or email is already assigned.');
    }
    $insert = $db->prepare('INSERT INTO users (id, identifier, email, name, role, password_hash, is_active, created_at) VALUES (?, ?, ?, ?, "admin", ?, 1, UTC_TIMESTAMP(3))');
    $insert->execute([
        uuid_v4(),
        $username,
        $email !== '' ? $email : null,
        getenv('ADMIN_NAME') ?: 'Portal Administrator',
        password_hash($password, PASSWORD_DEFAULT)
    ]);
}

function authenticated_user(PDO $db): ?array
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!preg_match('/^Bearer\s+(.+)$/i', $header, $matches)) {
        return null;
    }
    $tokenHash = hash('sha256', trim($matches[1]));
    $query = $db->prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) AND u.is_active = 1 LIMIT 1');
    $query->execute([$tokenHash]);
    return $query->fetch() ?: null;
}

function material_columns(string $alias = ''): string
{
    $prefix = $alias === '' ? '' : $alias . '.';
    return implode(',', array_map(static fn(string $column): string => $prefix . $column, [
        'id','lecturer_id','lecturer_name','course_id','course_code','course_title','level',
        'title','topic_tag','resource_type','file_name','content_type','size_bytes','resource_url','created_at'
    ]));
}

function require_role(?array $user, string $role): array
{
    if (!$user || $user['role'] !== $role) {
        respond(401, ['error' => ucfirst($role) . ' authentication required.']);
    }
    return $user;
}

function revoke_sessions(PDO $db, string $userId): void
{
    $delete = $db->prepare('DELETE FROM sessions WHERE user_id = ?');
    $delete->execute([$userId]);
}

function send_portal_email(array $recipient, string $subject, string $body): void
{
    $host = getenv('SMTP_HOST') ?: '';
    $username = getenv('SMTP_USER') ?: '';
    $password = getenv('SMTP_PASS') ?: '';
    $clientUrl = rtrim(getenv('CLIENT_URL') ?: '', '/');
    if ($host === '' || $username === '' || $password === '' || $clientUrl === '') {
        throw new RuntimeException('Portal email delivery is not configured.');
    }
    $parsedClientUrl = parse_url($clientUrl);
    if (!is_array($parsedClientUrl) || !in_array($parsedClientUrl['scheme'] ?? '', ['http', 'https'], true) ||
        empty($parsedClientUrl['host']) || isset($parsedClientUrl['user']) || isset($parsedClientUrl['pass'])) {
        throw new RuntimeException('CLIENT_URL must be a valid HTTP(S) origin.');
    }
    if (!class_exists(\PHPMailer\PHPMailer\PHPMailer::class)) {
        throw new RuntimeException('The PHP mail dependency is missing. Run composer install.');
    }

    $mailer = new \PHPMailer\PHPMailer\PHPMailer(true);
    $mailer->isSMTP();
    $mailer->Host = $host;
    $mailer->Port = (int)(getenv('SMTP_PORT') ?: '587');
    $mailer->SMTPAuth = true;
    $mailer->Username = $username;
    $mailer->Password = $password;
    if (strtolower(getenv('SMTP_SECURE') ?: 'false') === 'true') {
        $mailer->SMTPSecure = \PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_SMTPS;
    } else {
        $mailer->SMTPSecure = \PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_STARTTLS;
    }

    $from = trim(getenv('MAIL_FROM') ?: $username);
    $fromName = '';
    $fromAddress = $from;
    if (preg_match('/^(.*?)\s*<([^<>]+)>$/', $from, $matches)) {
        $fromName = trim($matches[1], " \t\n\r\0\x0B\"'");
        $fromAddress = trim($matches[2]);
    }
    if (!filter_var($fromAddress, FILTER_VALIDATE_EMAIL)) {
        throw new RuntimeException('MAIL_FROM must contain a valid email address.');
    }

    $mailer->CharSet = 'UTF-8';
    $mailer->setFrom($fromAddress, $fromName);
    $mailer->addAddress($recipient['email'], $recipient['name']);
    $mailer->isHTML(false);
    $mailer->Subject = $subject;
    $mailer->Body = $body;
    $mailer->send();
}

function send_password_reset_email(array $user, string $token): void
{
    $clientUrl = rtrim(getenv('CLIENT_URL') ?: '', '/');
    $resetUrl = $clientUrl . '/reset-password.html?token=' . rawurlencode($token);
    send_portal_email(
        $user,
        'Reset your FUTO IFT account password',
        "Hello {$user['name']},\n\nReset your password using this link:\n{$resetUrl}\n\nThis link expires in 30 minutes. If you did not request this, ignore this email."
    );
}

function iso_time(?string $value): ?string
{
    if ($value === null || $value === '') {
        return null;
    }
    return (new DateTimeImmutable($value, new DateTimeZone('UTC')))
        ->setTimezone(new DateTimeZone('UTC'))
        ->format('Y-m-d\TH:i:s.v\Z');
}

function student_enrolled(PDO $db, string $studentId, string $courseId): bool
{
    $query = $db->prepare('SELECT 1 FROM course_enrollments WHERE student_id = ? AND course_id = ? LIMIT 1');
    $query->execute([$studentId, $courseId]);
    return (bool)$query->fetchColumn();
}

function course_row(PDO $db, string $courseId, ?string $lecturerId = null): ?array
{
    $sql = 'SELECT c.*, u.name AS lecturer_name FROM taught_courses c JOIN users u ON u.id = c.lecturer_id WHERE c.id = ?';
    $args = [$courseId];
    if ($lecturerId !== null) {
        $sql .= ' AND c.lecturer_id = ?';
        $args[] = $lecturerId;
    }
    $query = $db->prepare($sql . ' LIMIT 1');
    $query->execute($args);
    return $query->fetch() ?: null;
}

function json_course(array $course): array
{
    return [
        'id' => $course['id'],
        'lecturerId' => $course['lecturer_id'],
        'lecturerName' => $course['lecturer_name'] ?? '',
        'courseCode' => $course['course_code'],
        'courseTitle' => $course['course_title'],
        'level' => $course['level'],
        'day' => $course['day'],
        'startTime' => substr($course['start_time'], 0, 5),
        'endTime' => substr($course['end_time'], 0, 5),
        'room' => $course['room'],
        'createdAt' => iso_time($course['created_at'])
    ];
}

function notify_enrolled(PDO $db, array $course, string $title, string $body, string $type, string $referenceId): void
{
    $students = $db->prepare('SELECT student_id FROM course_enrollments WHERE course_id = ?');
    $students->execute([$course['id']]);
    $insert = $db->prepare('INSERT INTO notifications (id, user_id, course_id, title, body, type, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))');
    foreach ($students->fetchAll() as $student) {
        $insert->execute([uuid_v4(), $student['student_id'], $course['id'], $title, $body, $type, $referenceId]);
    }
}

function material_row(PDO $db, string $materialId, bool $includeContent = false): ?array
{
    $columns = material_columns() . ($includeContent ? ',file_data' : '');
    $query = $db->prepare('SELECT ' . $columns . ' FROM course_materials WHERE id = ? LIMIT 1');
    $query->execute([$materialId]);
    return $query->fetch() ?: null;
}

function public_material(array $material): array
{
    $result = [
        'id' => $material['id'],
        'lecturerId' => $material['lecturer_id'],
        'lecturerName' => $material['lecturer_name'],
        'courseId' => $material['course_id'],
        'courseCode' => $material['course_code'],
        'courseTitle' => $material['course_title'],
        'level' => $material['level'],
        'title' => $material['title'],
        'topicTag' => $material['topic_tag'],
        'resourceType' => $material['resource_type'],
        'createdAt' => iso_time($material['created_at'])
    ];
    if ($material['resource_type'] === 'video') {
        $result['resourceUrl'] = $material['resource_url'];
    } else {
        $result['fileName'] = $material['file_name'];
        $result['contentType'] = $material['content_type'];
        $result['sizeBytes'] = (int)$material['size_bytes'];
        $result['downloadUrl'] = '/api/materials/' . $material['id'] . '/download';
    }
    return $result;
}

function quiz_questions(array $quiz): array
{
    $questions = json_decode($quiz['questions'], true);
    return is_array($questions) ? $questions : [];
}

function quiz_summary(array $quiz, bool $includeLecturer): array
{
    $result = [
        'id' => $quiz['id'],
        'courseId' => $quiz['course_id'],
        'title' => $quiz['title'],
        'courseCode' => $quiz['course_code'],
        'courseTitle' => $quiz['course_title'],
        'topicTag' => $quiz['topic_tag'],
        'passThreshold' => (int)$quiz['pass_threshold'],
        'durationMinutes' => (int)$quiz['duration_minutes'],
        'questionCount' => count(quiz_questions($quiz)),
        'createdAt' => iso_time($quiz['created_at'])
    ];
    if ($includeLecturer) {
        $result['lecturerName'] = $quiz['lecturer_name'];
    }
    return $result;
}

function json_quiz_result(array $result): array
{
    $answers = $result['answers'] === null ? null : json_decode($result['answers'], true);
    return [
        'id' => $result['id'],
        'userId' => $result['user_id'],
        'courseCode' => $result['course_code'],
        'quizId' => $result['quiz_id'],
        'quizTitle' => $result['quiz_title'],
        'courseId' => $result['course_id'],
        'topicTag' => $result['topic_tag'],
        'passThreshold' => $result['pass_threshold'] === null ? null : (int)$result['pass_threshold'],
        'answers' => $answers,
        'score' => (int)$result['score'],
        'correct' => $result['correct_count'] === null ? null : (int)$result['correct_count'],
        'total' => $result['question_count'] === null ? null : (int)$result['question_count'],
        'date' => iso_time($result['created_at'])
    ];
}

function quiz_by_id(PDO $db, string $quizId): ?array
{
    $query = $db->prepare('SELECT q.*,u.name AS lecturer_name FROM quizzes q JOIN users u ON u.id=q.lecturer_id WHERE q.id=? LIMIT 1');
    $query->execute([$quizId]);
    return $query->fetch() ?: null;
}

function auth_login(PDO $db, array $payload, int $status = 200): never
{
    $role = $payload['role'] ?? 'student';
    if (!in_array($role, ['student', 'lecturer', 'admin'], true)) {
        respond(400, ['error' => 'Choose a valid account role.']);
    }
    $identifier = $role === 'student'
        ? strtolower(trim((string)($payload['matric'] ?? '')))
        : strtolower(trim((string)($payload['username'] ?? $payload['email'] ?? '')));
    if (strlen($identifier) < 3 || strlen((string)($payload['password'] ?? '')) < 6) {
        respond(400, ['error' => 'A valid username and password are required.']);
    }
    $query = $db->prepare('SELECT * FROM users WHERE role = ? AND (identifier = ? OR email = ?) AND is_active = 1 LIMIT 1');
    $query->execute([$role, $identifier, strtolower(trim((string)($payload['email'] ?? $identifier)))]);
    $user = $query->fetch();
    if (!$user || !password_verify((string)$payload['password'], $user['password_hash'])) {
        respond(401, ['error' => 'Invalid login credentials.']);
    }
    $remember = $role === 'lecturer' && ($payload['rememberMe'] ?? false) === true;
    $token = bin2hex(random_bytes(32));
    $expires = new DateTimeImmutable(($remember ? '+30 days' : '+8 hours'), new DateTimeZone('UTC'));
    $insert = $db->prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))');
    $insert->execute([
        hash('sha256', $token),
        $user['id'],
        $expires->format('Y-m-d H:i:s.v')
    ]);
    respond($status, ['user' => public_user($user), 'token' => $token]);
}

function admin_users(PDO $db, string $method, string $path, array $payload, array $admin): never
{
    if ($path === '/api/admin/users' && $method === 'GET') {
        $rows = $db->query('SELECT * FROM users ORDER BY created_at DESC')->fetchAll();
        respond(200, ['users' => array_map('public_user', $rows)]);
    }
    if ($path === '/api/admin/users' && $method === 'POST') {
        $name = trim((string)($payload['name'] ?? ''));
        $email = strtolower(trim((string)($payload['email'] ?? '')));
        $role = $payload['role'] ?? '';
        $identifier = strtolower(trim((string)($payload['identifier'] ?? '')));
        $password = (string)($payload['password'] ?? '');
        $level = (string)($payload['level'] ?? '');
        $validIdentifier = $role === 'student'
            ? (bool)preg_match('/^202\d{8}$/', $identifier)
            : strlen($identifier) >= 3 && strlen($identifier) <= 80;
        if (!in_array($role, ['student', 'lecturer', 'admin'], true) || strlen($name) < 3 || strlen($name) > 100 ||
            !$validIdentifier || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($password) < 12 ||
            ($role === 'student' && !in_array($level, ['100', '200', '300', '400', '500'], true))) {
            respond(400, ['error' => 'Provide a valid name, email, role, identifier, and 12-character password; students also need a valid matric number and level.']);
        }
        $userId = uuid_v4();
        try {
            $insert = $db->prepare('INSERT INTO users (id, identifier, email, name, role, dept, level, password_hash, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(3))');
            $insert->execute([
                $userId, $identifier, $email, $name, $role,
                $role === 'student' ? 'IFT' : null,
                $role === 'student' ? $level : null,
                password_hash($password, PASSWORD_DEFAULT)
            ]);
        } catch (PDOException $error) {
            if ($error->getCode() === '23000') {
                respond(409, ['error' => 'That username, matric number, or email is already assigned.']);
            }
            throw $error;
        }
        $query = $db->prepare('SELECT * FROM users WHERE id = ?');
        $query->execute([$userId]);
        respond(201, ['user' => public_user($query->fetch())]);
    }
    if (preg_match('#^/api/admin/users/([a-f0-9-]+)/(role|status)$#i', $path, $matches) && $method === 'POST') {
        $targetId = $matches[1];
        if ($targetId === $admin['id']) {
            respond(409, ['error' => 'You cannot change your own role or account status.']);
        }
        $query = $db->prepare('SELECT * FROM users WHERE id = ? LIMIT 1');
        $query->execute([$targetId]);
        $target = $query->fetch();
        if (!$target) {
            respond(404, ['error' => 'User not found.']);
        }
        if ($matches[2] === 'role') {
            $role = $payload['role'] ?? '';
            if (!in_array($role, ['student', 'lecturer', 'admin'], true)) {
                respond(400, ['error' => 'Choose a valid account role.']);
            }
            if ($target['role'] === 'admin' && $role !== 'admin') {
                $count = (int)$db->query("SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1")->fetchColumn();
                if ($count <= 1) {
                    respond(409, ['error' => 'The final active administrator cannot be demoted.']);
                }
            }
            $update = $db->prepare('UPDATE users SET role = ? WHERE id = ?');
            $update->execute([$role, $targetId]);
            revoke_sessions($db, $targetId);
        } else {
            if (!is_bool($payload['isActive'] ?? null)) {
                respond(400, ['error' => 'Account status must be active or inactive.']);
            }
            if (!$payload['isActive'] && $target['role'] === 'admin') {
                $count = (int)$db->query("SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1")->fetchColumn();
                if ($count <= 1) {
                    respond(409, ['error' => 'The final active administrator cannot be disabled.']);
                }
            }
            $update = $db->prepare('UPDATE users SET is_active = ? WHERE id = ?');
            $update->execute([$payload['isActive'] ? 1 : 0, $targetId]);
            if (!$payload['isActive']) {
                revoke_sessions($db, $targetId);
            }
        }
        $query->execute([$targetId]);
        respond(200, ['user' => public_user($query->fetch())]);
    }
    respond(404, ['error' => 'Administrator user route not found.']);
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$payload = json_decode(file_get_contents('php://input'), true);
if (!is_array($payload)) {
    $payload = [];
}

try {
    $db = db_connection();
    provision_initial_admin($db);

    if ($path === '/api/health' && $method === 'GET') {
        respond(200, ['status' => 'ok', 'service' => 'futo-ift-api-php']);
    }

    if ($path === '/api/auth/register' && $method === 'POST') {
        if (($payload['role'] ?? 'student') !== 'student') {
            respond(403, ['error' => 'Lecturer and administrator accounts must be created by an administrator.']);
        }
        $name = trim((string)($payload['name'] ?? ''));
        $email = strtolower(trim((string)($payload['email'] ?? '')));
        $matric = strtolower(trim((string)($payload['matric'] ?? '')));
        $password = (string)($payload['password'] ?? '');
        $level = (string)($payload['level'] ?? '');
        if (strlen($name) < 3 || strlen($name) > 100 || !filter_var($email, FILTER_VALIDATE_EMAIL) ||
            !preg_match('/^202\d{8}$/', $matric) || !in_array($level, ['100', '200', '300', '400', '500'], true) ||
            strlen($password) < 6) {
            respond(400, ['error' => 'Provide a valid name, email, matric number, level, and password.']);
        }
        try {
            $insert = $db->prepare('INSERT INTO users (id, identifier, email, name, role, dept, level, password_hash, is_active, created_at) VALUES (?, ?, ?, ?, "student", "IFT", ?, ?, 1, UTC_TIMESTAMP(3))');
            $insert->execute([uuid_v4(), $matric, $email, $name, $level, password_hash($password, PASSWORD_DEFAULT)]);
        } catch (PDOException $error) {
            if ($error->getCode() === '23000') {
                respond(409, ['error' => 'An account with these details already exists.']);
            }
            throw $error;
        }
        try {
            send_portal_email(
                ['email' => $email, 'name' => $name],
                'Your FUTO IFT student account',
                "Hello {$name},\n\nYour FUTO IFT student account has been created.\nMatriculation number: {$matric}\nEmail: {$email}\nLogin: " . rtrim(getenv('CLIENT_URL') ?: '', '/') . "/index.html\n\nFor security, your password is not included in this email. Use the password you chose during registration. You can reset it from the login page if needed.\n\nRegards,\nFUTO IFT Portal"
            );
        } catch (Throwable $error) {
            error_log('Student welcome email delivery failed.');
            respond(503, ['error' => 'Your account was created, but the welcome email could not be sent. You can still sign in.']);
        }
        auth_login($db, ['role' => 'student', 'matric' => $matric, 'password' => $password], 201);
    }

    if ($path === '/api/auth/login' && $method === 'POST') {
        auth_login($db, $payload);
    }
    if ($path === '/api/auth/logout' && $method === 'POST') {
        $header = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
        if (preg_match('/^Bearer\s+(.+)$/i', $header, $matches)) {
            $delete = $db->prepare('DELETE FROM sessions WHERE token_hash = ?');
            $delete->execute([hash('sha256', trim($matches[1]))]);
        }
        respond(200, ['message' => 'Logged out.']);
    }
    if ($path === '/api/auth/me' && $method === 'GET') {
        $user = authenticated_user($db);
        respond($user ? 200 : 401, $user ? ['user' => public_user($user)] : ['error' => 'Authentication required.']);
    }
    if ($path === '/api/auth/forgot-password' && $method === 'POST') {
        $email = strtolower(trim((string)($payload['email'] ?? '')));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            respond(400, ['error' => 'Enter a valid email address.']);
        }
        $query = $db->prepare('SELECT id,email,name FROM users WHERE email=? AND is_active=1 LIMIT 1');
        $query->execute([$email]);
        $user = $query->fetch();
        if ($user) {
            $token = bin2hex(random_bytes(32));
            $tokenHash = hash('sha256', $token);
            $update = $db->prepare('UPDATE users SET reset_token_hash=?,reset_token_expires_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 MINUTE) WHERE id=?');
            $update->execute([$tokenHash,$user['id']]);
            try {
                send_password_reset_email($user, $token);
            } catch (Throwable $error) {
                $clearToken = $db->prepare('UPDATE users SET reset_token_hash=NULL,reset_token_expires_at=NULL WHERE id=? AND reset_token_hash=?');
                $clearToken->execute([$user['id'],$tokenHash]);
                error_log('Password reset email delivery failed.');
                respond(503, ['error' => 'Password reset email could not be sent. Please try again later.']);
            }
        }
        respond(200, ['message' => 'If that email belongs to an active FUTO IFT account, a reset link has been sent.']);
    }
    if ($path === '/api/auth/reset-password' && $method === 'POST') {
        $token = (string)($payload['token'] ?? '');
        $password = $payload['password'] ?? null;
        if (!preg_match('/^[a-f0-9]{64}$/i', $token) || !is_string($password) || strlen($password) < 6) {
            respond(400, ['error' => 'This reset link is invalid or expired, or the password is too short.']);
        }
        try {
            $db->beginTransaction();
            $query = $db->prepare('SELECT id FROM users WHERE reset_token_hash=? AND reset_token_expires_at>UTC_TIMESTAMP(3) AND is_active=1 LIMIT 1 FOR UPDATE');
            $query->execute([hash('sha256', $token)]);
            $user = $query->fetch();
            if (!$user) {
                $db->rollBack();
                respond(400, ['error' => 'This reset link is invalid or expired, or the password is too short.']);
            }
            $update = $db->prepare('UPDATE users SET password_hash=?,reset_token_hash=NULL,reset_token_expires_at=NULL WHERE id=?');
            $update->execute([password_hash($password, PASSWORD_DEFAULT),$user['id']]);
            revoke_sessions($db, $user['id']);
            $db->commit();
        } catch (Throwable $error) {
            if ($db->inTransaction()) $db->rollBack();
            throw $error;
        }
        respond(200, ['message' => 'Password reset successfully.']);
    }
    if (str_starts_with($path, '/api/admin/users')) {
        $admin = require_role(authenticated_user($db), 'admin');
        admin_users($db, $method, $path, $payload, $admin);
    }

    if ($path === '/api/lecturer/courses' && $method === 'GET') {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $query = $db->prepare("SELECT * FROM taught_courses WHERE lecturer_id = ? ORDER BY FIELD(day, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'), start_time");
        $query->execute([$lecturer['id']]);
        respond(200, ['courses' => array_map(fn(array $course): array => json_course($course + ['lecturer_name' => $lecturer['name']]), $query->fetchAll())]);
    }

    if ($path === '/api/lecturer/courses' && $method === 'POST') {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $courseCode = strtoupper(trim((string)($payload['courseCode'] ?? '')));
        $courseTitle = trim((string)($payload['courseTitle'] ?? ''));
        $level = (string)($payload['level'] ?? '');
        $day = (string)($payload['day'] ?? '');
        $startTime = (string)($payload['startTime'] ?? '');
        $endTime = (string)($payload['endTime'] ?? '');
        $room = trim((string)($payload['room'] ?? ''));
        $days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        $toMinutes = static fn(string $time): int => preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/', $time) ? ((int)substr($time, 0, 2) * 60 + (int)substr($time, 3, 2)) : -1;
        if ($courseCode === '' || strlen($courseCode) > 20 || strlen($courseTitle) < 3 || strlen($courseTitle) > 120 ||
            !in_array($level, ['100', '200', '300', '400', '500'], true) || !in_array($day, $days, true) ||
            $toMinutes($startTime) < 0 || $toMinutes($endTime) <= $toMinutes($startTime) || strlen($room) > 80) {
            respond(400, ['error' => 'Provide a valid course, level, day, time range, and room.']);
        }
        $id = uuid_v4();
        $insert = $db->prepare('INSERT INTO taught_courses (id, lecturer_id, course_code, course_title, level, day, start_time, end_time, room, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))');
        $insert->execute([$id, $lecturer['id'], $courseCode, $courseTitle, $level, $day, $startTime, $endTime, $room]);
        $query = $db->prepare('SELECT c.*, u.name AS lecturer_name FROM taught_courses c JOIN users u ON u.id=c.lecturer_id WHERE c.id=?');
        $query->execute([$id]);
        respond(201, ['course' => json_course($query->fetch())]);
    }

    if ($path === '/api/courses' && $method === 'GET') {
        $student = require_role(authenticated_user($db), 'student');
        $query = $db->prepare("SELECT c.*, u.name AS lecturer_name, IF(e.student_id IS NULL, 0, 1) AS is_enrolled FROM taught_courses c JOIN users u ON u.id=c.lecturer_id LEFT JOIN course_enrollments e ON e.course_id=c.id AND e.student_id=? WHERE c.level=? ORDER BY c.course_code");
        $query->execute([$student['id'], (string)$student['level']]);
        $courses = array_map(static function(array $course): array {
            $result = json_course($course);
            $result['enrolled'] = (bool)$course['is_enrolled'];
            return $result;
        }, $query->fetchAll());
        respond(200, ['courses' => $courses]);
    }

    if (preg_match('#^/api/courses/([a-f0-9-]+)/enroll$#i', $path, $matches) && $method === 'POST') {
        $student = require_role(authenticated_user($db), 'student');
        $course = course_row($db, $matches[1]);
        if (!$course || $course['level'] !== (string)$student['level']) {
            respond(404, ['error' => 'This course is not available for your registered level.']);
        }
        $insert = $db->prepare('INSERT IGNORE INTO course_enrollments (student_id, course_id, enrolled_at) VALUES (?, ?, UTC_TIMESTAMP(3))');
        $insert->execute([$student['id'], $course['id']]);
        respond(200, ['enrolled' => true, 'courseId' => $course['id']]);
    }

    if ($path === '/api/notifications' && $method === 'GET') {
        $user = authenticated_user($db);
        if (!$user) respond(401, ['error' => 'Authentication required.']);
        $query = $db->prepare("SELECT n.* FROM notifications n LEFT JOIN course_enrollments e ON e.course_id=n.course_id AND e.student_id=n.user_id WHERE n.user_id=? AND (? <> 'student' OR n.course_id IS NULL OR e.student_id IS NOT NULL) ORDER BY n.created_at DESC");
        $query->execute([$user['id'], $user['role']]);
        $notifications = array_map(static fn(array $item): array => [
            'id' => $item['id'], 'userId' => $item['user_id'], 'courseId' => $item['course_id'],
            'title' => $item['title'], 'body' => $item['body'], 'type' => $item['type'],
            'referenceId' => $item['reference_id'], 'readAt' => iso_time($item['read_at']),
            'createdAt' => iso_time($item['created_at'])
        ], $query->fetchAll());
        respond(200, ['notifications' => $notifications, 'unreadCount' => count(array_filter($notifications, static fn(array $item): bool => $item['readAt'] === null))]);
    }

    if (preg_match('#^/api/notifications/([a-f0-9-]+)/read$#i', $path, $matches) && $method === 'POST') {
        $user = authenticated_user($db);
        if (!$user) respond(401, ['error' => 'Authentication required.']);
        $query = $db->prepare('SELECT * FROM notifications WHERE id=? AND user_id=? LIMIT 1');
        $query->execute([$matches[1], $user['id']]);
        $notification = $query->fetch();
        if (!$notification) respond(404, ['error' => 'Notification not found.']);
        $update = $db->prepare('UPDATE notifications SET read_at=COALESCE(read_at, UTC_TIMESTAMP(3)) WHERE id=?');
        $update->execute([$matches[1]]);
        $query->execute([$matches[1], $user['id']]);
        $item = $query->fetch();
        respond(200, ['notification' => [
            'id' => $item['id'], 'userId' => $item['user_id'], 'courseId' => $item['course_id'],
            'title' => $item['title'], 'body' => $item['body'], 'type' => $item['type'],
            'referenceId' => $item['reference_id'], 'readAt' => iso_time($item['read_at']),
            'createdAt' => iso_time($item['created_at'])
        ]]);
    }

    if (preg_match('#^/api/lecturer/courses/([a-f0-9-]+)/students(?:/([a-f0-9-]+))?$#i', $path, $matches)) {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $course = course_row($db, $matches[1], $lecturer['id']);
        if (!$course) respond(404, ['error' => 'Course not found.']);
        $studentId = $matches[2] ?? '';
        if ($method === 'GET' && $studentId === '') {
            $query = $db->prepare('SELECT u.id,u.name,u.identifier,u.level,e.enrolled_at FROM course_enrollments e JOIN users u ON u.id=e.student_id WHERE e.course_id=? ORDER BY u.name');
            $query->execute([$course['id']]);
            $students = array_map(static fn(array $row): array => [
                'id' => $row['id'], 'name' => $row['name'], 'matric' => $row['identifier'],
                'level' => $row['level'], 'enrolledAt' => iso_time($row['enrolled_at'])
            ], $query->fetchAll());
            respond(200, ['course' => ['id' => $course['id'], 'courseCode' => $course['course_code'], 'courseTitle' => $course['course_title']], 'students' => $students]);
        }
        if ($method === 'POST' && $studentId === '') {
            $matric = strtolower(trim((string)($payload['matric'] ?? '')));
            $query = $db->prepare("SELECT id,name,identifier,level FROM users WHERE role='student' AND identifier=? AND level=? AND is_active=1 LIMIT 1");
            $query->execute([$matric, $course['level']]);
            $student = $query->fetch();
            if (!$student) respond(404, ['error' => 'No student with that matric number is registered at this course level.']);
            $insert = $db->prepare('INSERT IGNORE INTO course_enrollments (student_id,course_id,enrolled_at,added_by) VALUES (?,?,UTC_TIMESTAMP(3),?)');
            $insert->execute([$student['id'], $course['id'], $lecturer['id']]);
            respond(200, ['enrolled' => true, 'student' => ['id' => $student['id'], 'name' => $student['name'], 'matric' => $student['identifier'], 'level' => $student['level']]]);
        }
        if ($method === 'DELETE' && $studentId !== '') {
            $delete = $db->prepare('DELETE FROM course_enrollments WHERE course_id=? AND student_id=?');
            $delete->execute([$course['id'], $studentId]);
            respond(200, ['removed' => $delete->rowCount() > 0]);
        }
        respond(405, ['error' => 'Method not allowed.']);
    }

    if ($path === '/api/announcements' && $method === 'GET') {
        $user = authenticated_user($db);
        if (!$user) respond(401, ['error' => 'Authentication required.']);
        $sql = 'SELECT a.* FROM course_announcements a';
        $sql .= $user['role'] === 'lecturer'
            ? ' WHERE a.lecturer_id=?'
            : ' JOIN course_enrollments e ON e.course_id=a.course_id AND e.student_id=?';
        $sql .= ' ORDER BY a.created_at DESC';
        $query = $db->prepare($sql);
        $query->execute([$user['id']]);
        $announcements = array_map(static fn(array $row): array => [
            'id' => $row['id'], 'lecturerId' => $row['lecturer_id'], 'lecturerName' => $row['lecturer_name'],
            'courseId' => $row['course_id'], 'courseCode' => $row['course_code'], 'courseTitle' => $row['course_title'],
            'title' => $row['title'], 'body' => $row['body'], 'createdAt' => iso_time($row['created_at'])
        ], $query->fetchAll());
        respond(200, ['announcements' => $announcements]);
    }

    if ($path === '/api/lecturer/announcements' && $method === 'POST') {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $course = course_row($db, (string)($payload['courseId'] ?? ''), $lecturer['id']);
        $title = trim((string)($payload['title'] ?? ''));
        $body = trim((string)($payload['body'] ?? ''));
        if (!$course || strlen($title) < 3 || strlen($title) > 160 || $body === '' || strlen($body) > 5000) {
            respond(400, ['error' => 'Choose one of your courses and provide a title and message.']);
        }
        $id = uuid_v4();
        $insert = $db->prepare('INSERT INTO course_announcements (id,lecturer_id,course_id,course_code,course_title,lecturer_name,title,body,created_at) VALUES (?,?,?,?,?,?,?, ?,UTC_TIMESTAMP(3))');
        $insert->execute([$id,$lecturer['id'],$course['id'],$course['course_code'],$course['course_title'],$lecturer['name'],$title,$body]);
        notify_enrolled($db, $course, 'Announcement: ' . $title, $course['course_code'] . ' · ' . mb_substr($body, 0, 220), 'announcement', $id);
        $query = $db->prepare('SELECT * FROM course_announcements WHERE id=?');
        $query->execute([$id]);
        $row = $query->fetch();
        respond(201, ['announcement' => [
            'id' => $row['id'], 'lecturerId' => $row['lecturer_id'], 'lecturerName' => $row['lecturer_name'],
            'courseId' => $row['course_id'], 'courseCode' => $row['course_code'], 'courseTitle' => $row['course_title'],
            'title' => $row['title'], 'body' => $row['body'], 'createdAt' => iso_time($row['created_at'])
        ]]);
    }

    if ($path === '/api/materials' && $method === 'GET') {
        $user = authenticated_user($db);
        if (!$user) respond(401, ['error' => 'Authentication required.']);
        if ($user['role'] === 'lecturer') {
            $query = $db->prepare('SELECT ' . material_columns() . ' FROM course_materials WHERE lecturer_id=? ORDER BY created_at DESC');
            $query->execute([$user['id']]);
        } else {
            $query = $db->prepare('SELECT ' . material_columns('m') . ' FROM course_materials m JOIN course_enrollments e ON e.course_id=m.course_id WHERE e.student_id=? ORDER BY m.created_at DESC');
            $query->execute([$user['id']]);
        }
        respond(200, ['materials' => array_map('public_material', $query->fetchAll())]);
    }

    if ($path === '/api/lecturer/materials' && $method === 'POST') {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $course = course_row($db, (string)($payload['courseId'] ?? ''), $lecturer['id']);
        $title = trim((string)($payload['title'] ?? ''));
        $topicTag = trim((string)($payload['topicTag'] ?? ''));
        $resourceType = ($payload['resourceType'] ?? '') === 'video' ? 'video' : 'file';
        $fileName = basename(str_replace('\\', '/', (string)($payload['fileName'] ?? '')));
        $extensions = [
            'pdf' => 'application/pdf', 'doc' => 'application/msword',
            'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'txt' => 'text/plain'
        ];
        $extension = strtolower(pathinfo($fileName, PATHINFO_EXTENSION));
        $content = null;
        $contentType = null;
        $resourceUrl = null;
        if ($resourceType === 'video') {
            $resourceUrl = trim((string)($payload['resourceUrl'] ?? ''));
            if (!filter_var($resourceUrl, FILTER_VALIDATE_URL) || parse_url($resourceUrl, PHP_URL_SCHEME) !== 'https' ||
                parse_url($resourceUrl, PHP_URL_USER) !== null || parse_url($resourceUrl, PHP_URL_PASS) !== null) {
                respond(400, ['error' => 'Provide a valid HTTPS link to the video resource.']);
            }
        } else {
            $encoded = preg_replace('/^data:[^,]*;base64,/', '', (string)($payload['contentBase64'] ?? ''));
            if (!isset($extensions[$extension]) || $encoded === '' || base64_decode($encoded, true) === false) {
                respond(400, ['error' => 'Upload a PDF, DOC, DOCX, or TXT file.']);
            }
            $content = base64_decode($encoded, true);
            if ($content === false || strlen($content) === 0 || strlen($content) > 4 * 1024 * 1024) {
                respond(413, ['error' => 'Files must be smaller than 4 MB.']);
            }
            $contentType = $extensions[$extension];
        }
        if (!$course || strlen($title) < 3 || strlen($title) > 160 || strlen($topicTag) < 2 || strlen($topicTag) > 100) {
            respond(400, ['error' => 'Choose a course and provide a title and topic tag.']);
        }
        $id = uuid_v4();
        $insert = $db->prepare('INSERT INTO course_materials (id,lecturer_id,lecturer_name,course_id,course_code,course_title,level,title,topic_tag,resource_type,file_name,content_type,size_bytes,file_data,resource_url,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))');
        $insert->execute([
            $id,$lecturer['id'],$lecturer['name'],$course['id'],$course['course_code'],$course['course_title'],$course['level'],
            $title,$topicTag,$resourceType,$resourceType === 'file' ? $fileName : null,$contentType,
            $content === null ? null : strlen($content),$content,$resourceUrl
        ]);
        notify_enrolled($db, $course, 'New course material: ' . $title, $course['course_code'] . ' · ' . $title, 'material', $id);
        respond(201, ['material' => public_material(material_row($db, $id))]);
    }

    if (preg_match('#^/api/materials/([a-f0-9-]+)/download$#i', $path, $matches) && $method === 'GET') {
        $user = authenticated_user($db);
        if (!$user) respond(401, ['error' => 'Authentication required.']);
        $material = material_row($db, $matches[1], true);
        if (!$material) respond(404, ['error' => 'Material not found.']);
        $allowed = $user['role'] === 'lecturer'
            ? $material['lecturer_id'] === $user['id']
            : student_enrolled($db, $user['id'], $material['course_id']);
        if (!$allowed) respond(403, ['error' => 'Enroll in this course to access its materials.']);
        if ($material['resource_type'] === 'video') respond(400, ['error' => 'Open the video using its resource link.']);
        if ($material['file_data'] === null) respond(404, ['error' => 'The stored file is unavailable.']);
        header('Content-Type: ' . $material['content_type']);
        header('Content-Length: ' . strlen($material['file_data']));
        header("Content-Disposition: attachment; filename*=UTF-8''" . rawurlencode($material['file_name']));
        header('Cache-Control: private, no-store');
        echo $material['file_data'];
        exit;
    }

    if ($path === '/api/lecturer/quizzes' && $method === 'GET') {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $query = $db->prepare('SELECT q.*,u.name AS lecturer_name,(SELECT COUNT(*) FROM quiz_results r WHERE r.quiz_id=q.id) AS attempt_count FROM quizzes q JOIN users u ON u.id=q.lecturer_id WHERE q.lecturer_id=? ORDER BY q.created_at DESC');
        $query->execute([$lecturer['id']]);
        $quizzes = array_map(static function(array $quiz): array {
            $result = quiz_summary($quiz, false);
            $result['attemptCount'] = (int)$quiz['attempt_count'];
            return $result;
        }, $query->fetchAll());
        respond(200, ['quizzes' => $quizzes]);
    }

    if ($path === '/api/lecturer/quizzes' && $method === 'POST') {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $title = trim((string)($payload['title'] ?? ''));
        $topicTag = trim((string)($payload['topicTag'] ?? ''));
        $passThreshold = filter_var($payload['passThreshold'] ?? null, FILTER_VALIDATE_INT);
        $durationMinutes = filter_var($payload['durationMinutes'] ?? null, FILTER_VALIDATE_INT);
        $course = course_row($db, (string)($payload['courseId'] ?? ''), $lecturer['id']);
        $questions = $payload['questions'] ?? null;
        $validQuestions = is_array($questions) && count($questions) >= 2 && count($questions) <= 40;
        if ($validQuestions) {
            foreach ($questions as $question) {
                if (!is_array($question) || !is_string($question['q'] ?? null) || trim($question['q']) === '' ||
                    strlen($question['q']) > 1000 || !is_array($question['opts'] ?? null) ||
                    count($question['opts']) < 2 || count($question['opts']) > 4 ||
                    !is_int($question['ans'] ?? null) || $question['ans'] < 0 ||
                    $question['ans'] >= count($question['opts']) ||
                    (isset($question['exp']) && (!is_string($question['exp']) || strlen($question['exp']) > 1500))) {
                    $validQuestions = false;
                    break;
                }
                foreach ($question['opts'] as $option) {
                    if (!is_string($option) || trim($option) === '' || strlen($option) > 500) {
                        $validQuestions = false;
                        break 2;
                    }
                }
            }
        }
        if (strlen($title) < 3 || strlen($title) > 120 || strlen($topicTag) < 2 || strlen($topicTag) > 100 ||
            $passThreshold === false || $passThreshold < 0 || $passThreshold > 100 || !$course ||
            $durationMinutes === false || $durationMinutes < 1 || $durationMinutes > 180 || !$validQuestions) {
            respond(400, ['error' => 'Choose a course, provide a title and topic tag, set a mastery threshold from 0 to 100, a duration from 1 to 180 minutes, and 2 to 40 valid questions.']);
        }
        $normalizedQuestions = array_map(static fn(array $question): array => [
            'q' => trim($question['q']),
            'opts' => array_map('trim', $question['opts']),
            'ans' => $question['ans'],
            'exp' => is_string($question['exp'] ?? null) ? trim($question['exp']) : ''
        ], $questions);
        $id = uuid_v4();
        $insert = $db->prepare('INSERT INTO quizzes (id,lecturer_id,course_id,course_code,course_title,lecturer_name,title,topic_tag,pass_threshold,duration_minutes,questions,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))');
        $insert->execute([
            $id,$lecturer['id'],$course['id'],$course['course_code'],$course['course_title'],$lecturer['name'],
            $title,$topicTag,$passThreshold,$durationMinutes,json_encode($normalizedQuestions, JSON_THROW_ON_ERROR)
        ]);
        notify_enrolled($db, $course, 'New quiz: ' . $title, $course['course_code'] . ' · ' . $durationMinutes . ' minute' . ($durationMinutes === 1 ? '' : 's'), 'quiz', $id);
        respond(201, ['quiz' => ['id' => $id, 'title' => $title, 'courseCode' => $course['course_code'], 'topicTag' => $topicTag, 'passThreshold' => $passThreshold, 'questionCount' => count($normalizedQuestions)]]);
    }

    if (preg_match('#^/api/lecturer/quizzes/([a-f0-9-]+)/results$#i', $path, $matches) && $method === 'GET') {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $quiz = quiz_by_id($db, $matches[1]);
        if (!$quiz || $quiz['lecturer_id'] !== $lecturer['id']) respond(404, ['error' => 'Quiz not found.']);
        $query = $db->prepare('SELECT r.*,u.name AS student_name,u.identifier AS student_identifier,u.level AS student_level,(SELECT COUNT(*) FROM quiz_results all_attempts WHERE all_attempts.quiz_id=r.quiz_id AND all_attempts.user_id=r.user_id) AS attempt_count FROM quiz_results r JOIN users u ON u.id=r.user_id WHERE r.quiz_id=? ORDER BY r.created_at');
        $query->execute([$quiz['id']]);
        $attempts = $query->fetchAll();
        $bestByStudent = [];
        foreach ($attempts as $attempt) {
            $prior = $bestByStudent[$attempt['user_id']] ?? null;
            if ($prior === null || (int)$attempt['score'] > (int)$prior['score']) $bestByStudent[$attempt['user_id']] = $attempt;
        }
        $leaderboard = array_map(static fn(array $row): array => [
            'name' => $row['student_name'], 'matric' => $row['student_identifier'],
            'level' => $row['student_level'], 'score' => (int)$row['score'],
            'correct' => (int)$row['correct_count'], 'total' => (int)$row['question_count'],
            'date' => iso_time($row['created_at']), 'attemptCount' => (int)$row['attempt_count']
        ], array_values($bestByStudent));
        usort($leaderboard, static fn(array $a, array $b): int => $b['score'] <=> $a['score'] ?: strcmp($a['name'], $b['name']));
        $questionStats = [];
        foreach (quiz_questions($quiz) as $index => $question) {
            $answered = 0;
            $correct = 0;
            foreach ($attempts as $attempt) {
                $answers = $attempt['answers'] === null ? null : json_decode($attempt['answers'], true);
                if (!is_array($answers) || !array_key_exists($index, $answers) || $answers[$index] === null) continue;
                $answered++;
                if ($answers[$index] === $question['ans']) $correct++;
            }
            $questionStats[] = [
                'question' => $question['q'], 'responseCount' => $answered,
                'correctCount' => $correct, 'correctPercent' => $answered ? (int)round($correct / $answered * 100) : 0
            ];
        }
        respond(200, [
            'quiz' => ['id' => $quiz['id'], 'title' => $quiz['title'], 'courseCode' => $quiz['course_code'], 'topicTag' => $quiz['topic_tag'], 'passThreshold' => (int)$quiz['pass_threshold']],
            'attempts' => count($attempts), 'leaderboard' => $leaderboard, 'questionStats' => $questionStats
        ]);
    }

    if ($path === '/api/lecturer/topic-performance' && $method === 'GET') {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $query = $db->prepare("SELECT q.course_id,q.course_code,q.topic_tag,q.pass_threshold,COUNT(r.id) AS attempts,SUM(r.score) AS total_score,ROUND(AVG(r.score)) AS average_score,SUM(r.score < q.pass_threshold) AS below_count FROM quizzes q JOIN quiz_results r ON r.quiz_id=q.id WHERE q.lecturer_id=? GROUP BY q.course_id,q.course_code,q.topic_tag,q.pass_threshold ORDER BY q.course_code,q.topic_tag");
        $query->execute([$lecturer['id']]);
        $topics = array_map(static function(array $row): array {
            $attempts = (int)$row['attempts'];
            return [
                'courseId' => $row['course_id'], 'courseCode' => $row['course_code'],
                'topicTag' => $row['topic_tag'], 'passThreshold' => (int)$row['pass_threshold'],
                'attempts' => $attempts, 'totalScore' => (int)$row['total_score'],
                'belowThresholdCount' => (int)$row['below_count'], 'averageScore' => (int)$row['average_score'],
                'belowThresholdPercent' => (int)round((int)$row['below_count'] / $attempts * 100)
            ];
        }, $query->fetchAll());
        respond(200, ['topics' => $topics]);
    }

    if ($path === '/api/quizzes' && $method === 'GET') {
        $student = require_role(authenticated_user($db), 'student');
        $query = $db->prepare('SELECT q.*,u.name AS lecturer_name FROM quizzes q JOIN users u ON u.id=q.lecturer_id JOIN course_enrollments e ON e.course_id=q.course_id AND e.student_id=? ORDER BY q.created_at DESC');
        $query->execute([$student['id']]);
        respond(200, ['quizzes' => array_map(static fn(array $quiz): array => quiz_summary($quiz, true), $query->fetchAll())]);
    }

    if (preg_match('#^/api/quizzes/([a-f0-9-]+)/start$#i', $path, $matches) && $method === 'POST') {
        $student = require_role(authenticated_user($db), 'student');
        $quiz = quiz_by_id($db, $matches[1]);
        if (!$quiz) respond(404, ['error' => 'Quiz not found.']);
        if (!student_enrolled($db, $student['id'], $quiz['course_id'])) respond(403, ['error' => 'Enroll in this course before starting its quiz.']);
        $attemptId = uuid_v4();
        $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $expires = $now->modify('+' . (int)$quiz['duration_minutes'] . ' minutes');
        $insert = $db->prepare('INSERT INTO quiz_attempts (id,quiz_id,student_id,started_at,expires_at) VALUES (?,?,?,?,?)');
        $insert->execute([$attemptId,$quiz['id'],$student['id'],$now->format('Y-m-d H:i:s.v'),$expires->format('Y-m-d H:i:s.v')]);
        $questions = array_map(static fn(array $question): array => ['q' => $question['q'], 'opts' => $question['opts']], quiz_questions($quiz));
        respond(201, [
            'attemptId' => $attemptId, 'expiresAt' => $expires->format('Y-m-d\TH:i:s.v\Z'),
            'quiz' => [
                'id' => $quiz['id'], 'title' => $quiz['title'], 'courseCode' => $quiz['course_code'],
                'courseId' => $quiz['course_id'], 'topicTag' => $quiz['topic_tag'],
                'passThreshold' => (int)$quiz['pass_threshold'], 'durationMinutes' => (int)$quiz['duration_minutes'],
                'questions' => $questions
            ]
        ]);
    }

    if (preg_match('#^/api/quizzes/([a-f0-9-]+)$#i', $path, $matches) && $method === 'GET') {
        $student = require_role(authenticated_user($db), 'student');
        $quiz = quiz_by_id($db, $matches[1]);
        if (!$quiz) respond(404, ['error' => 'Quiz not found.']);
        if (!student_enrolled($db, $student['id'], $quiz['course_id'])) respond(403, ['error' => 'Enroll in this course before viewing its quiz.']);
        $questions = array_map(static fn(array $question): array => ['q' => $question['q'], 'opts' => $question['opts']], quiz_questions($quiz));
        respond(200, ['quiz' => [
            'id' => $quiz['id'], 'title' => $quiz['title'], 'courseCode' => $quiz['course_code'],
            'durationMinutes' => (int)$quiz['duration_minutes'], 'questions' => $questions
        ]]);
    }

    if (preg_match('#^/api/quizzes/([a-f0-9-]+)/submit$#i', $path, $matches) && $method === 'POST') {
        $student = require_role(authenticated_user($db), 'student');
        $quiz = quiz_by_id($db, $matches[1]);
        if (!$quiz) respond(404, ['error' => 'Quiz not found.']);
        if (!student_enrolled($db, $student['id'], $quiz['course_id'])) respond(403, ['error' => 'Enroll in this course before submitting its quiz.']);
        $answers = $payload['answers'] ?? null;
        $questions = quiz_questions($quiz);
        if (!is_array($answers) || count($answers) !== count($questions)) respond(400, ['error' => 'Answers must contain one valid option or no answer for each question.']);
        foreach ($answers as $index => $answer) {
            if ($answer !== null && (!is_int($answer) || $answer < 0 || $answer >= count($questions[$index]['opts']))) {
                respond(400, ['error' => 'Answers must contain one valid option or no answer for each question.']);
            }
        }
        try {
            $db->beginTransaction();
            $attemptQuery = $db->prepare('SELECT * FROM quiz_attempts WHERE id=? AND quiz_id=? AND student_id=? FOR UPDATE');
            $attemptQuery->execute([(string)($payload['attemptId'] ?? ''),$quiz['id'],$student['id']]);
            $attempt = $attemptQuery->fetch();
            if (!$attempt) {
                $db->rollBack();
                respond(404, ['error' => 'Quiz attempt not found.']);
            }
            if ($attempt['submitted_at'] !== null) {
                $db->rollBack();
                respond(409, ['error' => 'This quiz attempt has already been submitted.']);
            }
            if (time() > (new DateTimeImmutable($attempt['expires_at'], new DateTimeZone('UTC')))->getTimestamp() + 60) {
                $db->rollBack();
                respond(409, ['error' => 'The time limit has expired.']);
            }
            $correct = 0;
            foreach ($questions as $index => $question) if ($answers[$index] === $question['ans']) $correct++;
            $score = (int)round($correct / count($questions) * 100);
            $topicTag = $quiz['topic_tag'] ?: $quiz['title'];
            $now = gmdate('Y-m-d H:i:s.v');
            $resultId = uuid_v4();
            $insertResult = $db->prepare('INSERT INTO quiz_results (id,user_id,course_id,quiz_id,course_code,quiz_title,topic_tag,pass_threshold,answers,score,correct_count,question_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
            $insertResult->execute([
                $resultId,$student['id'],$quiz['course_id'],$quiz['id'],$quiz['course_code'],$quiz['title'],
                $topicTag,(int)$quiz['pass_threshold'],json_encode($answers, JSON_THROW_ON_ERROR),$score,$correct,count($questions),$now
            ]);
            $updateAttempt = $db->prepare('UPDATE quiz_attempts SET submitted_at=?,score=? WHERE id=?');
            $updateAttempt->execute([$now,$score,$attempt['id']]);
            $progress = $db->prepare("INSERT INTO progress_logs (id,user_id,course_id,course_code,topic_tag,pass_threshold,attempt_count,total_score,average_score,last_score,mastery_level,last_updated) VALUES (?,?,?,?,?,?,1,?,?,?, ?,?) ON DUPLICATE KEY UPDATE attempt_count=attempt_count+1,total_score=total_score+VALUES(last_score),average_score=ROUND(total_score/attempt_count),pass_threshold=VALUES(pass_threshold),last_score=VALUES(last_score),mastery_level=VALUES(mastery_level),last_updated=VALUES(last_updated)");
            $progress->execute([
                uuid_v4(),$student['id'],$quiz['course_id'],$quiz['course_code'],$topicTag,(int)$quiz['pass_threshold'],
                $score,$score,$score,$score >= (int)$quiz['pass_threshold'] ? 'mastered' : 'below_threshold',$now
            ]);
            $db->commit();
            $result = [
                'id' => $resultId, 'userId' => $student['id'], 'courseCode' => $quiz['course_code'],
                'quizId' => $quiz['id'], 'quizTitle' => $quiz['title'], 'courseId' => $quiz['course_id'],
                'topicTag' => $topicTag, 'passThreshold' => (int)$quiz['pass_threshold'],
                'answers' => $answers, 'score' => $score, 'correct' => $correct, 'total' => count($questions),
                'date' => iso_time($now)
            ];
            $review = array_map(static fn(array $question, int $index): array => [
                'q' => $question['q'], 'opts' => $question['opts'], 'ans' => $question['ans'],
                'selected' => $answers[$index], 'exp' => $question['exp'] ?? ''
            ], $questions, array_keys($questions));
            respond(200, ['result' => $result, 'review' => $review]);
        } catch (Throwable $error) {
            if ($db->inTransaction()) $db->rollBack();
            throw $error;
        }
    }

    if ($path === '/api/student/progress' && $method === 'GET') {
        $student = require_role(authenticated_user($db), 'student');
        $query = $db->prepare('SELECT p.* FROM progress_logs p WHERE p.user_id=? ORDER BY p.last_updated DESC');
        $query->execute([$student['id']]);
        $progress = [];
        foreach ($query->fetchAll() as $row) {
            $item = [
                'id' => $row['id'], 'userId' => $row['user_id'], 'courseId' => $row['course_id'],
                'courseCode' => $row['course_code'], 'topicTag' => $row['topic_tag'],
                'passThreshold' => (int)$row['pass_threshold'], 'attemptCount' => (int)$row['attempt_count'],
                'totalScore' => (int)$row['total_score'], 'averageScore' => (int)$row['average_score'],
                'lastScore' => (int)$row['last_score'], 'masteryLevel' => $row['mastery_level'],
                'lastUpdated' => iso_time($row['last_updated']), 'recommendation' => null
            ];
            if ($row['mastery_level'] === 'below_threshold') {
                $resourceQuery = $db->prepare("SELECT " . material_columns('m') . " FROM course_materials m JOIN course_enrollments e ON e.course_id=m.course_id WHERE e.student_id=? AND m.course_id=? AND LOWER(m.topic_tag)=LOWER(?) ORDER BY m.created_at DESC LIMIT 1");
                $resourceQuery->execute([$student['id'],$row['course_id'],$row['topic_tag']]);
                $resource = $resourceQuery->fetch();
                if ($resource) $item['recommendation'] = [
                    'material' => public_material($resource),
                    'message' => 'Review this course material and try another quiz on the topic.'
                ];
            }
            $progress[] = $item;
        }
        respond(200, ['progress' => $progress]);
    }

    if ($path === '/api/student/quiz-results' && $method === 'GET') {
        $student = require_role(authenticated_user($db), 'student');
        $query = $db->prepare('SELECT * FROM quiz_results WHERE user_id=? ORDER BY created_at DESC LIMIT 50');
        $query->execute([$student['id']]);
        $results = array_map('json_quiz_result', $query->fetchAll());
        foreach ($results as &$result) unset($result['answers']);
        unset($result);
        respond(200, ['results' => $results]);
    }

    if ($path === '/api/quiz/results' && $method === 'POST') {
        $student = require_role(authenticated_user($db), 'student');
        $courseCode = is_string($payload['courseCode'] ?? null) ? trim($payload['courseCode']) : '';
        $score = $payload['score'] ?? null;
        if ($courseCode === '' || strlen($courseCode) > 20 || !is_numeric($score) ||
            !is_finite((float)$score) || (float)$score < 0 || (float)$score > 100 ||
            (float)$score !== (float)(int)$score) {
            respond(400, ['error' => 'Provide a course code of 1–20 characters and a whole-number score from 0 to 100.']);
        }
        $id = uuid_v4();
        $now = gmdate('Y-m-d H:i:s.v');
        $insert = $db->prepare('INSERT INTO quiz_results (id,user_id,course_code,score,created_at) VALUES (?,?,?,?,?)');
        $insert->execute([$id,$student['id'],$courseCode,(int)$score,$now]);
        respond(201, ['result' => ['id' => $id,'userId' => $student['id'],'courseCode' => $courseCode,'score' => (int)$score,'date' => iso_time($now)]]);
    }

    if ($path === '/api/leaderboard' && $method === 'GET') {
        $limit = filter_var($_GET['limit'] ?? 10, FILTER_VALIDATE_INT);
        $limit = max(1, min(100, $limit === false ? 10 : $limit));
        $query = $db->query('SELECT r.* FROM quiz_results r JOIN users u ON u.id=r.user_id WHERE NOT EXISTS (SELECT 1 FROM quiz_results better WHERE better.user_id=r.user_id AND better.course_code=r.course_code AND (better.score>r.score OR (better.score=r.score AND better.created_at>r.created_at))) ORDER BY r.score DESC,r.created_at DESC LIMIT ' . $limit);
        $leaderboard = [];
        foreach ($query->fetchAll() as $row) {
            $userQuery = $db->prepare('SELECT * FROM users WHERE id=?');
            $userQuery->execute([$row['user_id']]);
            $result = json_quiz_result($row);
            $result['user'] = public_user($userQuery->fetch());
            $leaderboard[] = $result;
        }
        respond(200, ['leaderboard' => $leaderboard]);
    }

    if ($path === '/api/admin/chat-intents' && $method === 'GET') {
        require_role(authenticated_user($db), 'admin');
        $materialRows = $db->query('SELECT ' . material_columns() . ' FROM course_materials ORDER BY created_at DESC')->fetchAll();
        $materialsById = [];
        foreach ($materialRows as $material) $materialsById[$material['id']] = public_material($material);
        $rows = $db->query('SELECT * FROM chat_intents ORDER BY created_at DESC')->fetchAll();
        $intents = array_map(static function(array $intent) use ($materialsById): array {
            $phrases = json_decode($intent['sample_phrases'], true);
            return [
                'id' => $intent['id'], 'topicTag' => $intent['topic_tag'],
                'explanation' => $intent['explanation'], 'samplePhrases' => is_array($phrases) ? $phrases : [],
                'linkedMaterialId' => $intent['linked_material_id'],
                'createdAt' => iso_time($intent['created_at']), 'updatedAt' => iso_time($intent['updated_at']),
                'material' => $materialsById[$intent['linked_material_id']] ?? null
            ];
        }, $rows);
        respond(200, ['intents' => $intents, 'materials' => array_values($materialsById)]);
    }

    if ($path === '/api/admin/chat-intents' && $method === 'POST') {
        require_role(authenticated_user($db), 'admin');
        $topicTag = trim((string)($payload['topicTag'] ?? ''));
        $explanation = trim((string)($payload['explanation'] ?? ''));
        $materialId = (string)($payload['linkedMaterialId'] ?? '');
        $phrases = $payload['samplePhrases'] ?? [];
        $phrases = is_array($phrases) ? array_values(array_unique(array_filter(array_map(
            static fn($phrase): string => is_string($phrase) ? trim($phrase) : '',
            $phrases
        )))) : [];
        $material = material_row($db, $materialId);
        if (strlen($topicTag) < 2 || strlen($topicTag) > 100 || $explanation === '' || strlen($explanation) > 500 ||
            count($phrases) < 1 || count($phrases) > 12 ||
            count(array_filter($phrases, static fn(string $phrase): bool => strlen($phrase) < 3 || strlen($phrase) > 180)) > 0 ||
            !$material) {
            respond(400, ['error' => 'Provide a topic, explanation, 1–12 sample phrases, and an existing linked course resource.']);
        }
        $id = uuid_v4();
        $now = gmdate('Y-m-d H:i:s.v');
        $insert = $db->prepare('INSERT INTO chat_intents (id,topic_tag,explanation,sample_phrases,linked_material_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
        $insert->execute([$id,$topicTag,$explanation,json_encode($phrases, JSON_THROW_ON_ERROR),$materialId,$now,$now]);
        respond(201, ['intent' => [
            'id' => $id, 'topicTag' => $topicTag, 'explanation' => $explanation, 'samplePhrases' => $phrases,
            'linkedMaterialId' => $materialId, 'createdAt' => iso_time($now), 'updatedAt' => iso_time($now)
        ]]);
    }

    if (preg_match('#^/api/admin/chat-intents/([a-f0-9-]+)$#i', $path, $matches) && in_array($method, ['POST', 'DELETE'], true)) {
        require_role(authenticated_user($db), 'admin');
        $query = $db->prepare('SELECT * FROM chat_intents WHERE id=? LIMIT 1');
        $query->execute([$matches[1]]);
        $intent = $query->fetch();
        if (!$intent) respond(404, ['error' => 'Chatbot intent not found.']);
        if ($method === 'DELETE') {
            $delete = $db->prepare('DELETE FROM chat_intents WHERE id=?');
            $delete->execute([$intent['id']]);
            respond(200, ['deleted' => true, 'id' => $intent['id']]);
        }
        $topicTag = trim((string)($payload['topicTag'] ?? ''));
        $explanation = trim((string)($payload['explanation'] ?? ''));
        $materialId = (string)($payload['linkedMaterialId'] ?? '');
        $phrases = $payload['samplePhrases'] ?? [];
        $phrases = is_array($phrases) ? array_values(array_unique(array_filter(array_map(
            static fn($phrase): string => is_string($phrase) ? trim($phrase) : '',
            $phrases
        )))) : [];
        if (strlen($topicTag) < 2 || strlen($topicTag) > 100 || $explanation === '' || strlen($explanation) > 500 ||
            count($phrases) < 1 || count($phrases) > 12 ||
            count(array_filter($phrases, static fn(string $phrase): bool => strlen($phrase) < 3 || strlen($phrase) > 180)) > 0 ||
            !material_row($db, $materialId)) {
            respond(400, ['error' => 'Provide a topic, explanation, 1–12 sample phrases, and an existing linked course resource.']);
        }
        $now = gmdate('Y-m-d H:i:s.v');
        $update = $db->prepare('UPDATE chat_intents SET topic_tag=?,explanation=?,sample_phrases=?,linked_material_id=?,updated_at=? WHERE id=?');
        $update->execute([$topicTag,$explanation,json_encode($phrases, JSON_THROW_ON_ERROR),$materialId,$now,$intent['id']]);
        respond(200, ['intent' => [
            'id' => $intent['id'], 'topicTag' => $topicTag, 'explanation' => $explanation,
            'samplePhrases' => $phrases, 'linkedMaterialId' => $materialId,
            'createdAt' => iso_time($intent['created_at']), 'updatedAt' => iso_time($now)
        ]]);
    }

    if ($path === '/api/lecturer/chat-analytics' && $method === 'GET') {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $query = $db->prepare("SELECT c.course_code,COALESCE(i.topic_tag,m.topic_tag,'Unmatched query') AS topic_tag,COUNT(*) AS query_count,SUM(l.matched_material_id IS NULL) AS fallback_count,MAX(l.created_at) AS last_asked_at FROM chat_logs l JOIN users s ON s.id=l.user_id AND s.role='student' LEFT JOIN course_materials m ON m.id=l.matched_material_id LEFT JOIN taught_courses c ON c.id=COALESCE(l.course_id,m.course_id) LEFT JOIN course_enrollments e ON e.course_id=c.id AND e.student_id=l.user_id LEFT JOIN chat_intents i ON i.id=l.matched_intent_id WHERE c.lecturer_id=? AND e.student_id IS NOT NULL GROUP BY c.id,c.course_code,COALESCE(i.topic_tag,m.topic_tag,'Unmatched query') ORDER BY query_count DESC,topic_tag LIMIT 20");
        $query->execute([$lecturer['id']]);
        $topics = array_map(static fn(array $row): array => [
            'courseCode' => $row['course_code'], 'topicTag' => $row['topic_tag'],
            'queryCount' => (int)$row['query_count'], 'fallbackCount' => (int)$row['fallback_count'],
            'lastAskedAt' => iso_time($row['last_asked_at'])
        ], $query->fetchAll());
        respond(200, ['topics' => $topics]);
    }

    if ($path === '/api/student/chat' && $method === 'POST') {
        $student = require_role(authenticated_user($db), 'student');
        $question = trim((string)($payload['query'] ?? ''));
        if (strlen($question) < 3 || strlen($question) > 500) respond(400, ['error' => 'Ask a question between 3 and 500 characters.']);
        $requestedCourseId = (string)($payload['courseId'] ?? '');
        if ($requestedCourseId !== '' && !student_enrolled($db, $student['id'], $requestedCourseId)) {
            respond(403, ['error' => 'Enroll in this course before searching its resources.']);
        }
        $sql = 'SELECT ' . material_columns('m') . ' FROM course_materials m JOIN course_enrollments e ON e.course_id=m.course_id WHERE e.student_id=?';
        $args = [$student['id']];
        if ($requestedCourseId !== '') {
            $sql .= ' AND m.course_id=?';
            $args[] = $requestedCourseId;
        }
        $sql .= ' ORDER BY m.created_at DESC';
        $materialQuery = $db->prepare($sql);
        $materialQuery->execute($args);
        $materials = $materialQuery->fetchAll();
        $materialsById = [];
        foreach ($materials as $material) $materialsById[$material['id']] = $material;
        $intents = [];
        if ($materialsById) {
            $placeholders = implode(',', array_fill(0, count($materialsById), '?'));
            $intentQuery = $db->prepare('SELECT * FROM chat_intents WHERE linked_material_id IN (' . $placeholders . ')');
            $intentQuery->execute(array_keys($materialsById));
            $intents = $intentQuery->fetchAll();
        }
        $tokens = static function(string $value): array {
            preg_match_all('/[a-z0-9]+/i', strtolower($value), $matches);
            return $matches[0];
        };
        $stopWords = ['about','after','again','also','and','are','can','could','explain','find','for','from','help','how','into','please','show','the','this','what','with'];
        $score = static function(string $text, array $resourceTerms) use ($tokens, $stopWords): float {
            $queryTerms = array_values(array_unique(array_filter($tokens($text), static fn(string $token): bool => strlen($token) > 2 && !in_array($token, $stopWords, true))));
            if (!$queryTerms) return 0;
            $terms = array_unique($resourceTerms);
            return count(array_intersect($queryTerms, $terms)) / count($queryTerms);
        };
        $materialMatches = [];
        foreach ($materials as $material) {
            $resourceTerms = $tokens(implode(' ', [$material['topic_tag'], $material['title'], $material['file_name'] ?? '']));
            $materialMatches[] = ['material' => $material, 'confidence' => $score($question, $resourceTerms)];
        }
        usort($materialMatches, static fn(array $a,array $b): int => $b['confidence'] <=> $a['confidence']);
        $intentMatches = [];
        foreach ($intents as $intent) {
            $phrases = json_decode($intent['sample_phrases'], true);
            $intentMatches[] = [
                'intent' => $intent, 'material' => $materialsById[$intent['linked_material_id']],
                'confidence' => $score($question, $tokens($intent['topic_tag'] . ' ' . implode(' ', is_array($phrases) ? $phrases : []) . ' ' . $intent['explanation']))
            ];
        }
        usort($intentMatches, static fn(array $a,array $b): int => $b['confidence'] <=> $a['confidence']);
        $intentMatch = ($intentMatches[0]['confidence'] ?? 0) >= 0.34 ? $intentMatches[0] : null;
        $materialMatch = ($materialMatches[0]['confidence'] ?? 0) >= 0.34 ? $materialMatches[0] : null;
        $match = $intentMatch ?? $materialMatch;
        $matchedMaterial = $match['material'] ?? null;
        $now = gmdate('Y-m-d H:i:s.v');
        $insertLog = $db->prepare('INSERT INTO chat_logs (id,user_id,course_id,query_text,matched_material_id,matched_intent_id,confidence,created_at) VALUES (?,?,?,?,?,?,?,?)');
        $insertLog->execute([
            uuid_v4(),$student['id'],$requestedCourseId ?: ($matchedMaterial['course_id'] ?? null),$question,
            $matchedMaterial['id'] ?? null,$intentMatch['intent']['id'] ?? null,$match['confidence'] ?? 0,$now
        ]);
        if (!$match) respond(200, [
            'answer' => 'I could not find a confident match in your enrolled course materials. Try including the course topic or a key term, or ask your lecturer for help.',
            'resource' => null, 'confidence' => 0
        ]);
        $material = $matchedMaterial;
        $public = public_material($material);
        $resource = [
            'id' => $material['id'], 'courseId' => $material['course_id'], 'courseCode' => $material['course_code'],
            'topicTag' => $material['topic_tag'], 'title' => $material['title'], 'resourceType' => $material['resource_type'],
            'courseUrl' => 'course.html?id=' . rawurlencode($material['course_id']) . '#material-' . rawurlencode($material['id'])
        ];
        if ($material['resource_type'] === 'video') $resource['resourceUrl'] = $material['resource_url'];
        else {
            $resource['fileName'] = $material['file_name'];
            $resource['downloadUrl'] = $public['downloadUrl'];
        }
        respond(200, [
            'answer' => $intentMatch ? $intentMatch['intent']['explanation'] : 'This course resource looks relevant to your question: ' . $material['title'] . '.',
            'confidence' => (int)round($match['confidence'] * 100), 'resource' => $resource
        ]);
    }

    if ($path === '/api/assignments' && $method === 'GET') {
        $user = authenticated_user($db);
        if (!$user) respond(401, ['error' => 'Authentication required.']);
        if ($user['role'] === 'lecturer') {
            $query = $db->prepare('SELECT a.*,(SELECT COUNT(*) FROM assignment_submissions s WHERE s.assignment_id=a.id) AS submission_count FROM assignments a WHERE a.lecturer_id=? ORDER BY a.due_at');
            $query->execute([$user['id']]);
            $assignments = array_map(static fn(array $row): array => [
                'id' => $row['id'], 'lecturerId' => $row['lecturer_id'], 'courseId' => $row['course_id'],
                'courseTitle' => $row['course_title'], 'courseCode' => $row['course_code'],
                'lecturerName' => $row['lecturer_name'], 'title' => $row['title'], 'description' => $row['description'],
                'dueAt' => iso_time($row['due_at']), 'createdAt' => iso_time($row['created_at']),
                'submissionCount' => (int)$row['submission_count']
            ], $query->fetchAll());
        } elseif ($user['role'] === 'student') {
            $query = $db->prepare('SELECT a.*,s.id AS submission_id,s.student_id AS submission_student_id,s.student_name,s.student_identifier,s.response,s.submitted_at,s.is_late,s.grade,s.feedback,s.graded_at,s.graded_by FROM assignments a JOIN course_enrollments e ON e.course_id=a.course_id AND e.student_id=? LEFT JOIN assignment_submissions s ON s.assignment_id=a.id AND s.student_id=? ORDER BY a.due_at');
            $query->execute([$user['id'],$user['id']]);
            $assignments = array_map(static function(array $row): array {
                $submission = null;
                if ($row['submission_id'] !== null) {
                    $submission = [
                        'id' => $row['submission_id'], 'assignmentId' => $row['id'],
                        'studentId' => $row['submission_student_id'], 'studentName' => $row['student_name'],
                        'studentIdentifier' => $row['student_identifier'], 'response' => $row['response'],
                        'submittedAt' => iso_time($row['submitted_at']), 'late' => (bool)$row['is_late'],
                        'grade' => $row['grade'] === null ? null : (float)$row['grade'],
                        'feedback' => $row['feedback'], 'gradedAt' => iso_time($row['graded_at']),
                        'gradedBy' => $row['graded_by']
                    ];
                }
                return [
                    'id' => $row['id'], 'lecturerId' => $row['lecturer_id'], 'courseId' => $row['course_id'],
                    'courseTitle' => $row['course_title'], 'courseCode' => $row['course_code'],
                    'lecturerName' => $row['lecturer_name'], 'title' => $row['title'],
                    'description' => $row['description'], 'dueAt' => iso_time($row['due_at']),
                    'createdAt' => iso_time($row['created_at']), 'submission' => $submission
                ];
            }, $query->fetchAll());
        } else {
            $assignments = [];
        }
        respond(200, ['assignments' => $assignments]);
    }

    if ($path === '/api/assignments' && $method === 'POST') {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $title = trim((string)($payload['title'] ?? ''));
        $description = trim((string)($payload['description'] ?? ''));
        $course = course_row($db, (string)($payload['courseId'] ?? ''), $lecturer['id']);
        $dueAtValue = $payload['dueAt'] ?? null;
        try {
            $dueAt = is_string($dueAtValue) && trim($dueAtValue) !== ''
                ? new DateTimeImmutable($dueAtValue)
                : null;
        } catch (Throwable) {
            $dueAt = null;
        }
        if (strlen($title) < 3 || strlen($title) > 120 || !$course ||
            $description === '' || strlen($description) > 5000 || !$dueAt) {
            respond(400, ['error' => 'Choose one of your courses and provide a title, description, and valid due date.']);
        }
        $id = uuid_v4();
        $created = new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $insert = $db->prepare('INSERT INTO assignments (id,lecturer_id,course_id,course_title,course_code,lecturer_name,title,description,due_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
        $insert->execute([
            $id,$lecturer['id'],$course['id'],$course['course_title'],$course['course_code'],$lecturer['name'],
            $title,$description,$dueAt->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s.v'),$created->format('Y-m-d H:i:s.v')
        ]);
        notify_enrolled($db, $course, 'New assignment: ' . $title, $course['course_code'] . ' · Due ' . $dueAt->format('Y-m-d H:i'), 'assignment', $id);
        respond(201, ['assignment' => [
            'id' => $id, 'lecturerId' => $lecturer['id'], 'courseId' => $course['id'],
            'courseTitle' => $course['course_title'], 'courseCode' => $course['course_code'],
            'lecturerName' => $lecturer['name'], 'title' => $title, 'description' => $description,
            'dueAt' => $dueAt->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z'),
            'createdAt' => $created->format('Y-m-d\TH:i:s.v\Z')
        ]]);
    }

    if (preg_match('#^/api/assignments/([a-f0-9-]+)/submissions$#i', $path, $matches) && $method === 'POST') {
        $student = require_role(authenticated_user($db), 'student');
        $assignmentQuery = $db->prepare('SELECT * FROM assignments WHERE id=?');
        $assignmentQuery->execute([$matches[1]]);
        $assignment = $assignmentQuery->fetch();
        if (!$assignment) respond(404, ['error' => 'Assignment not found.']);
        if (!student_enrolled($db, $student['id'], $assignment['course_id'])) respond(403, ['error' => 'Enroll in this course before submitting its assignment.']);
        $responseText = trim((string)($payload['response'] ?? ''));
        if ($responseText === '' || strlen($responseText) > 10000) respond(400, ['error' => 'Your response must be between 1 and 10,000 characters.']);
        $existingQuery = $db->prepare('SELECT * FROM assignment_submissions WHERE assignment_id=? AND student_id=?');
        $existingQuery->execute([$assignment['id'],$student['id']]);
        $existing = $existingQuery->fetch();
        if ($existing && $existing['grade'] !== null) respond(409, ['error' => 'This submission has already been graded and can no longer be changed.']);
        $id = $existing['id'] ?? uuid_v4();
        $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $late = $now > new DateTimeImmutable($assignment['due_at'], new DateTimeZone('UTC'));
        if ($existing) {
            $update = $db->prepare('UPDATE assignment_submissions SET student_name=?,student_identifier=?,response=?,submitted_at=?,is_late=?,grade=NULL,feedback=NULL,graded_at=NULL,graded_by=NULL WHERE id=?');
            $update->execute([$student['name'],$student['identifier'],$responseText,$now->format('Y-m-d H:i:s.v'),$late ? 1 : 0,$id]);
        } else {
            $insert = $db->prepare('INSERT INTO assignment_submissions (id,assignment_id,student_id,student_name,student_identifier,response,submitted_at,is_late) VALUES (?,?,?,?,?,?,?,?)');
            $insert->execute([$id,$assignment['id'],$student['id'],$student['name'],$student['identifier'],$responseText,$now->format('Y-m-d H:i:s.v'),$late ? 1 : 0]);
        }
        respond(201, ['submission' => [
            'id' => $id, 'assignmentId' => $assignment['id'], 'studentId' => $student['id'],
            'studentName' => $student['name'], 'studentIdentifier' => $student['identifier'],
            'response' => $responseText, 'submittedAt' => $now->format('Y-m-d\TH:i:s.v\Z'),
            'late' => $late
        ]]);
    }

    if (preg_match('#^/api/assignments/([a-f0-9-]+)/submissions$#i', $path, $matches) && $method === 'GET') {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $assignmentQuery = $db->prepare('SELECT id FROM assignments WHERE id=? AND lecturer_id=?');
        $assignmentQuery->execute([$matches[1],$lecturer['id']]);
        if (!$assignmentQuery->fetch()) respond(404, ['error' => 'Assignment not found.']);
        $query = $db->prepare('SELECT * FROM assignment_submissions WHERE assignment_id=? ORDER BY submitted_at');
        $query->execute([$matches[1]]);
        $submissions = array_map(static fn(array $row): array => [
            'id' => $row['id'], 'assignmentId' => $row['assignment_id'],
            'studentName' => $row['student_name'], 'studentIdentifier' => $row['student_identifier'],
            'response' => $row['response'], 'submittedAt' => iso_time($row['submitted_at']),
            'late' => (bool)$row['is_late'], 'grade' => $row['grade'] === null ? null : (float)$row['grade'],
            'feedback' => $row['feedback'], 'gradedAt' => iso_time($row['graded_at']), 'gradedBy' => $row['graded_by']
        ], $query->fetchAll());
        respond(200, ['submissions' => $submissions]);
    }

    if (preg_match('#^/api/assignments/([a-f0-9-]+)/submissions/([a-f0-9-]+)/grade$#i', $path, $matches) && $method === 'POST') {
        $lecturer = require_role(authenticated_user($db), 'lecturer');
        $assignmentQuery = $db->prepare('SELECT id FROM assignments WHERE id=? AND lecturer_id=?');
        $assignmentQuery->execute([$matches[1],$lecturer['id']]);
        if (!$assignmentQuery->fetch()) respond(404, ['error' => 'Assignment or submission not found.']);
        $gradeValue = $payload['grade'] ?? null;
        $feedback = trim((string)($payload['feedback'] ?? ''));
        if (!is_numeric($gradeValue) || !is_finite((float)$gradeValue) || (float)$gradeValue < 0 ||
            (float)$gradeValue > 100 || strlen($feedback) > 3000) {
            respond(400, ['error' => 'Grade must be between 0 and 100; feedback must be 3,000 characters or fewer.']);
        }
        $submissionQuery = $db->prepare('SELECT * FROM assignment_submissions WHERE id=? AND assignment_id=?');
        $submissionQuery->execute([$matches[2],$matches[1]]);
        $submission = $submissionQuery->fetch();
        if (!$submission) respond(404, ['error' => 'Assignment or submission not found.']);
        $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $update = $db->prepare('UPDATE assignment_submissions SET grade=?,feedback=?,graded_at=?,graded_by=? WHERE id=?');
        $update->execute([(float)$gradeValue,$feedback,$now->format('Y-m-d H:i:s.v'),$lecturer['name'],$submission['id']]);
        respond(200, ['submission' => [
            'id' => $submission['id'], 'assignmentId' => $submission['assignment_id'],
            'studentName' => $submission['student_name'], 'studentIdentifier' => $submission['student_identifier'],
            'response' => $submission['response'], 'submittedAt' => iso_time($submission['submitted_at']),
            'late' => (bool)$submission['is_late'], 'grade' => (float)$gradeValue,
            'feedback' => $feedback, 'gradedAt' => $now->format('Y-m-d\TH:i:s.v\Z'), 'gradedBy' => $lecturer['name']
        ]]);
    }

    respond(501, ['error' => 'This API route is not migrated to the PHP backend yet.', 'route' => $method . ' ' . $path]);
} catch (Throwable $error) {
    error_log($error->getMessage());
    respond(503, ['error' => 'PHP/MySQL API is unavailable. Check database configuration and schema installation.']);
}
