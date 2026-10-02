<?php
declare(strict_types=1);

const TABLES = [
    'users',
    'sessions',
    'taught_courses',
    'course_enrollments',
    'notifications',
    'course_announcements',
    'course_materials',
    'quizzes',
    'quiz_attempts',
    'quiz_results',
    'progress_logs',
    'chat_intents',
    'chat_logs',
    'assignments',
    'assignment_submissions'
];

function fail(string $message): never
{
    fwrite(STDERR, $message . PHP_EOL);
    exit(1);
}

function source_time(mixed $value, bool $nullable = false): ?string
{
    if ($value === null || $value === '') {
        if ($nullable) return null;
        return gmdate('Y-m-d H:i:s.v');
    }
    if (!is_string($value) && !is_int($value)) {
        throw new RuntimeException('Invalid timestamp in JSON export.');
    }
    try {
        return (new DateTimeImmutable((string)$value, new DateTimeZone('UTC')))
            ->setTimezone(new DateTimeZone('UTC'))
            ->format('Y-m-d H:i:s.v');
    } catch (Throwable) {
        throw new RuntimeException('Invalid timestamp in JSON export.');
    }
}

function export_rows(array $source, string $key): array
{
    $rows = $source[$key] ?? [];
    if (!is_array($rows) || !array_is_list($rows)) {
        throw new RuntimeException('Expected a list for JSON export section "' . $key . '".');
    }
    return $rows;
}

function row_id(array $row, string $table): string
{
    $id = $row['id'] ?? null;
    if (!is_string($id) || !preg_match('/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i', $id)) {
        throw new RuntimeException('Missing or invalid ID in section "' . $table . '".');
    }
    return $id;
}

function safe_email(mixed $value): ?string
{
    if (!is_string($value) || trim($value) === '') return null;
    $email = strtolower(trim($value));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        throw new RuntimeException('Invalid email address in user data.');
    }
    return $email;
}

function validate_user_uniqueness(array $rows): void
{
    $identifiers = [];
    $emails = [];
    foreach ($rows as $row) {
        if (!is_array($row)) {
            throw new RuntimeException('Invalid row in section "users".');
        }
        $identifierValue = $row['identifier'] ?? null;
        $identifier = is_string($identifierValue) ? strtolower(trim($identifierValue)) : '';
        if ($identifier === '' || strlen($identifier) > 80) {
            throw new RuntimeException('An account has an invalid or missing identifier.');
        }
        if (isset($identifiers[$identifier])) {
            throw new RuntimeException('Duplicate account identifiers exist in the JSON export; resolve them before importing.');
        }
        $identifiers[$identifier] = true;
        $email = safe_email($row['email'] ?? null);
        if ($email === null) {
            throw new RuntimeException('Each imported account needs a valid email address for password reset.');
        }
        if (isset($emails[$email])) {
            throw new RuntimeException('Duplicate account email addresses exist in the JSON export; resolve them before importing.');
        }
        $emails[$email] = true;
    }
}

function export_upload(string $uploadsRoot, mixed $storageName): string
{
    if (!is_string($storageName) || $storageName === '' || basename($storageName) !== $storageName ||
        !preg_match('/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.(pdf|doc|docx|txt)$/i', $storageName)) {
        throw new RuntimeException('Invalid stored course-material filename in JSON export.');
    }
    $file = realpath($uploadsRoot . DIRECTORY_SEPARATOR . $storageName);
    if ($file === false || !str_starts_with($file, $uploadsRoot . DIRECTORY_SEPARATOR) || !is_file($file)) {
        throw new RuntimeException('A referenced course-material file is missing from the uploads directory.');
    }
    $size = filesize($file);
    if ($size === false || $size < 1 || $size > 4 * 1024 * 1024) {
        throw new RuntimeException('A stored course-material file is empty or exceeds the 4 MB upload limit.');
    }
    $contents = file_get_contents($file);
    if ($contents === false) {
        throw new RuntimeException('A stored course-material file could not be read.');
    }
    return $contents;
}

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$backendRoot = dirname(__DIR__, 2);
$jsonPath = realpath($argv[1] ?? ($backendRoot . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'db.json'));
$uploadsPath = realpath($argv[2] ?? ($backendRoot . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'uploads'));
if ($jsonPath === false || !is_file($jsonPath) || $uploadsPath === false || !is_dir($uploadsPath)) {
    fail('Usage: php bin/import-json.php [path-to-db.json] [path-to-uploads-directory]');
}

$host = getenv('DB_HOST') ?: '';
$databaseName = getenv('DB_DATABASE') ?: '';
$username = getenv('DB_USERNAME') ?: '';
$password = getenv('DB_PASSWORD') ?: '';
if ($host === '' || $databaseName === '' || $username === '') {
    fail('Configure DB_HOST, DB_DATABASE, DB_USERNAME, and DB_PASSWORD before importing.');
}

$json = file_get_contents($jsonPath);
if ($json === false) fail('The JSON export could not be read.');
try {
    $source = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
} catch (JsonException) {
    fail('The JSON export is invalid.');
}
if (!is_array($source) || !isset($source['users']) || !is_array($source['users']) || !array_is_list($source['users'])) {
    fail('The JSON export does not contain a valid users list.');
}
try {
    validate_user_uniqueness($source['users']);
} catch (RuntimeException $error) {
    fail($error->getMessage());
}
$sourceHash = hash('sha256', $json);
unset($json);

try {
    $pdo = new PDO(
        'mysql:host=' . $host . ';port=' . (getenv('DB_PORT') ?: '3306') . ';dbname=' . $databaseName . ';charset=utf8mb4',
        $username,
        $password,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false
        ]
    );
} catch (Throwable) {
    fail('Could not connect to the configured MySQL database.');
}

$alreadyImported = $pdo->prepare('SELECT counts FROM migration_imports WHERE source_sha256=?');
$alreadyImported->execute([$sourceHash]);
$existingImport = $alreadyImported->fetchColumn();
if ($existingImport !== false) {
    fwrite(STDOUT, "This exact JSON export has already been imported; no changes were made." . PHP_EOL);
    exit(0);
}
if ((int)$pdo->query('SELECT COUNT(*) FROM migration_imports')->fetchColumn() > 0) {
    fail('Import refused: a different JSON export has already been imported into this database.');
}

$counts = [];
try {
    foreach (TABLES as $table) {
        $counts[$table] = 0;
        if ((int)$pdo->query('SELECT COUNT(*) FROM `' . $table . '`')->fetchColumn() !== 0) {
            fail('Import refused: table "' . $table . '" is not empty. Use an empty database or investigate before retrying.');
        }
    }

    $pdo->beginTransaction();
    $stage = 'users';
    $users = [];
    $insert = $pdo->prepare('INSERT INTO users (id,identifier,email,name,role,dept,level,password_hash,is_active,reset_token_hash,reset_token_expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?)');
    foreach (export_rows($source, 'users') as $row) {
        if (!is_array($row)) throw new RuntimeException('Invalid row in section "users".');
        $id = row_id($row, 'users');
        $role = $row['role'] ?? null;
        $identifier = strtolower(trim((string)($row['identifier'] ?? '')));
        $name = trim((string)($row['name'] ?? ''));
        $email = safe_email($row['email'] ?? null);
        if (!in_array($role, ['student', 'lecturer', 'admin'], true) ||
            $identifier === '' || strlen($identifier) > 80 || $name === '' || strlen($name) > 100 || $email === null) {
            throw new RuntimeException('An account has invalid or missing fields; each imported account needs a valid email for password reset.');
        }
        $active = ($row['isActive'] ?? true) !== false;
        $level = isset($row['level']) && $row['level'] !== '' ? (string)$row['level'] : null;
        if ($role === 'student' && !in_array($level, ['100', '200', '300', '400', '500'], true)) {
            throw new RuntimeException('A student account has an invalid or missing level.');
        }
        $temporaryHash = password_hash(bin2hex(random_bytes(32)), PASSWORD_DEFAULT);
        $insert->execute([
            $id,$identifier,$email,$name,$role,
            isset($row['dept']) ? (string)$row['dept'] : null,$level,$temporaryHash,
            $active ? 1 : 0,source_time($row['createdAt'] ?? null)
        ]);
        $users[$id] = $row;
        $counts['users']++;
    }

    $stage = 'taught_courses';
    $courses = [];
    $insert = $pdo->prepare('INSERT INTO taught_courses (id,lecturer_id,course_code,course_title,level,day,start_time,end_time,room,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    foreach (export_rows($source, 'taughtCourses') as $row) {
        if (!is_array($row)) throw new RuntimeException('Invalid row in section "taughtCourses".');
        $id = row_id($row, 'taughtCourses');
        $start = (string)($row['startTime'] ?? '');
        $end = (string)($row['endTime'] ?? '');
        if (!preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/', $start) || !preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/', $end)) {
            throw new RuntimeException('A course has an invalid schedule time.');
        }
        $insert->execute([
            $id,(string)($row['lecturerId'] ?? ''),strtoupper(trim((string)($row['courseCode'] ?? ''))),
            trim((string)($row['courseTitle'] ?? '')),(string)($row['level'] ?? ''),(string)($row['day'] ?? ''),
            $start,$end,(string)($row['room'] ?? ''),source_time($row['createdAt'] ?? null)
        ]);
        $courses[$id] = $row;
        $counts['taught_courses']++;
    }

    $stage = 'course_enrollments';
    $insert = $pdo->prepare('INSERT INTO course_enrollments (student_id,course_id,enrolled_at,added_by) VALUES (?,?,?,?)');
    foreach (export_rows($source, 'courseEnrollments') as $row) {
        if (!is_array($row)) throw new RuntimeException('Invalid row in section "courseEnrollments".');
        $insert->execute([
            (string)($row['studentId'] ?? ''),(string)($row['courseId'] ?? ''),
            source_time($row['enrolledAt'] ?? null),$row['addedBy'] ?? null
        ]);
        $counts['course_enrollments']++;
    }

    $stage = 'course_materials';
    $materials = [];
    $insert = $pdo->prepare('INSERT INTO course_materials (id,lecturer_id,lecturer_name,course_id,course_code,course_title,level,title,topic_tag,resource_type,file_name,content_type,size_bytes,file_data,resource_url,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    foreach (export_rows($source, 'courseMaterials') as $row) {
        if (!is_array($row)) throw new RuntimeException('Invalid row in section "courseMaterials".');
        $id = row_id($row, 'courseMaterials');
        $type = ($row['resourceType'] ?? 'file') === 'video' ? 'video' : 'file';
        $fileName = null;
        $contentType = null;
        $size = null;
        $contents = null;
        $url = null;
        if ($type === 'video') {
            $url = (string)($row['resourceUrl'] ?? '');
            if (!filter_var($url, FILTER_VALIDATE_URL) || parse_url($url, PHP_URL_SCHEME) !== 'https') {
                throw new RuntimeException('A video resource has an invalid HTTPS URL.');
            }
        } else {
            $fileName = basename(str_replace('\\', '/', (string)($row['fileName'] ?? '')));
            $contentType = (string)($row['contentType'] ?? 'application/octet-stream');
            $contents = export_upload($uploadsPath, $row['storageName'] ?? null);
            $size = strlen($contents);
        }
        $insert->execute([
            $id,(string)($row['lecturerId'] ?? ''),(string)($row['lecturerName'] ?? ''),
            (string)($row['courseId'] ?? ''),(string)($row['courseCode'] ?? ''),
            (string)($row['courseTitle'] ?? ''),(string)($row['level'] ?? ''),
            trim((string)($row['title'] ?? '')),trim((string)($row['topicTag'] ?? '')),
            $type,$fileName,$contentType,$size,$contents,$url,source_time($row['createdAt'] ?? null)
        ]);
        $materials[$id] = $row;
        $counts['course_materials']++;
    }

    $stage = 'course_announcements';
    $insert = $pdo->prepare('INSERT INTO course_announcements (id,lecturer_id,course_id,course_code,course_title,lecturer_name,title,body,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    foreach (export_rows($source, 'courseAnnouncements') as $row) {
        if (!is_array($row)) throw new RuntimeException('Invalid row in section "courseAnnouncements".');
        $course = $courses[(string)($row['courseId'] ?? '')] ?? [];
        $insert->execute([
            row_id($row, 'courseAnnouncements'),(string)($row['lecturerId'] ?? ''),
            (string)($row['courseId'] ?? ''),(string)($row['courseCode'] ?? $course['courseCode'] ?? ''),
            (string)($row['courseTitle'] ?? $course['courseTitle'] ?? ''),
            (string)($row['lecturerName'] ?? $users[(string)($row['lecturerId'] ?? '')]['name'] ?? ''),
            (string)($row['title'] ?? ''),(string)($row['body'] ?? ''),
            source_time($row['createdAt'] ?? null)
        ]);
        $counts['course_announcements']++;
    }

    $stage = 'notifications';
    $insert = $pdo->prepare('INSERT INTO notifications (id,user_id,course_id,title,body,type,reference_id,read_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    foreach (export_rows($source, 'notifications') as $row) {
        if (!is_array($row)) throw new RuntimeException('Invalid row in section "notifications".');
        $insert->execute([
            row_id($row, 'notifications'),(string)($row['userId'] ?? ''),$row['courseId'] ?? null,
            (string)($row['title'] ?? ''),(string)($row['body'] ?? ''),(string)($row['type'] ?? 'general'),
            $row['referenceId'] ?? null,source_time($row['readAt'] ?? null,true),
            source_time($row['createdAt'] ?? null)
        ]);
        $counts['notifications']++;
    }

    $stage = 'quizzes';
    $quizzes = [];
    $insert = $pdo->prepare('INSERT INTO quizzes (id,lecturer_id,course_id,course_code,course_title,lecturer_name,title,topic_tag,pass_threshold,duration_minutes,questions,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    foreach (export_rows($source, 'quizzes') as $row) {
        if (!is_array($row) || !is_array($row['questions'] ?? null)) throw new RuntimeException('A quiz has invalid question data.');
        $id = row_id($row, 'quizzes');
        $course = $courses[(string)($row['courseId'] ?? '')] ?? [];
        $questions = json_encode($row['questions'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
        $insert->execute([
            $id,(string)($row['lecturerId'] ?? ''),(string)($row['courseId'] ?? ''),
            (string)($row['courseCode'] ?? $course['courseCode'] ?? ''),
            (string)($row['courseTitle'] ?? $course['courseTitle'] ?? ''),
            (string)($row['lecturerName'] ?? $users[(string)($row['lecturerId'] ?? '')]['name'] ?? ''),
            (string)($row['title'] ?? ''),(string)($row['topicTag'] ?? $row['title'] ?? ''),
            (int)($row['passThreshold'] ?? 70),(int)($row['durationMinutes'] ?? 30),
            $questions,source_time($row['createdAt'] ?? null)
        ]);
        $quizzes[$id] = $row;
        $counts['quizzes']++;
    }

    $stage = 'quiz_attempts';
    $insert = $pdo->prepare('INSERT INTO quiz_attempts (id,quiz_id,student_id,started_at,expires_at,submitted_at,score) VALUES (?,?,?,?,?,?,?)');
    foreach (export_rows($source, 'quizAttempts') as $row) {
        if (!is_array($row)) throw new RuntimeException('Invalid row in section "quizAttempts".');
        $insert->execute([
            row_id($row, 'quizAttempts'),(string)($row['quizId'] ?? ''),(string)($row['studentId'] ?? ''),
            source_time($row['startedAt'] ?? null),source_time($row['expiresAt'] ?? null),
            source_time($row['submittedAt'] ?? null,true),isset($row['score']) ? (int)$row['score'] : null
        ]);
        $counts['quiz_attempts']++;
    }

    $stage = 'quiz_results';
    $insert = $pdo->prepare('INSERT INTO quiz_results (id,user_id,course_id,quiz_id,course_code,quiz_title,topic_tag,pass_threshold,answers,score,correct_count,question_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    foreach (export_rows($source, 'quizResults') as $row) {
        if (!is_array($row)) throw new RuntimeException('Invalid row in section "quizResults".');
        $quiz = $quizzes[(string)($row['quizId'] ?? '')] ?? [];
        $answers = isset($row['answers']) && is_array($row['answers'])
            ? json_encode($row['answers'], JSON_THROW_ON_ERROR)
            : null;
        $insert->execute([
            row_id($row, 'quizResults'),(string)($row['userId'] ?? ''),$row['courseId'] ?? $quiz['courseId'] ?? null,
            $row['quizId'] ?? null,(string)($row['courseCode'] ?? $quiz['courseCode'] ?? ''),
            $row['quizTitle'] ?? $quiz['title'] ?? null,$row['topicTag'] ?? $quiz['topicTag'] ?? null,
            isset($row['passThreshold']) ? (int)$row['passThreshold'] : (isset($quiz['passThreshold']) ? (int)$quiz['passThreshold'] : null),
            $answers,(int)($row['score'] ?? 0),isset($row['correct']) ? (int)$row['correct'] : null,
            isset($row['total']) ? (int)$row['total'] : null,
            source_time($row['date'] ?? $row['createdAt'] ?? null)
        ]);
        $counts['quiz_results']++;
    }

    $stage = 'progress_logs';
    $insert = $pdo->prepare('INSERT INTO progress_logs (id,user_id,course_id,course_code,topic_tag,pass_threshold,attempt_count,total_score,average_score,last_score,mastery_level,last_updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    foreach (export_rows($source, 'progressLogs') as $row) {
        if (!is_array($row)) throw new RuntimeException('Invalid row in section "progressLogs".');
        $insert->execute([
            row_id($row, 'progressLogs'),(string)($row['userId'] ?? ''),(string)($row['courseId'] ?? ''),
            (string)($row['courseCode'] ?? ''),(string)($row['topicTag'] ?? ''),(int)($row['passThreshold'] ?? 70),
            (int)($row['attemptCount'] ?? 0),(int)($row['totalScore'] ?? 0),(int)($row['averageScore'] ?? 0),
            (int)($row['lastScore'] ?? 0),($row['masteryLevel'] ?? '') === 'mastered' ? 'mastered' : 'below_threshold',
            source_time($row['lastUpdated'] ?? null)
        ]);
        $counts['progress_logs']++;
    }

    $stage = 'chat_intents';
    $intents = [];
    $insert = $pdo->prepare('INSERT INTO chat_intents (id,topic_tag,explanation,sample_phrases,linked_material_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
    foreach (export_rows($source, 'chatIntents') as $row) {
        if (!is_array($row) || !is_array($row['samplePhrases'] ?? null)) throw new RuntimeException('A chatbot intent has invalid sample phrases.');
        $id = row_id($row, 'chatIntents');
        $insert->execute([
            $id,(string)($row['topicTag'] ?? ''),(string)($row['explanation'] ?? ''),
            json_encode($row['samplePhrases'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE),
            (string)($row['linkedMaterialId'] ?? ''),source_time($row['createdAt'] ?? null),
            source_time($row['updatedAt'] ?? $row['createdAt'] ?? null)
        ]);
        $intents[$id] = $row;
        $counts['chat_intents']++;
    }

    $stage = 'chat_logs';
    $insert = $pdo->prepare('INSERT INTO chat_logs (id,user_id,course_id,query_text,matched_material_id,matched_intent_id,confidence,created_at) VALUES (?,?,?,?,?,?,?,?)');
    foreach (export_rows($source, 'chatLogs') as $row) {
        if (!is_array($row)) throw new RuntimeException('Invalid row in section "chatLogs".');
        $materialId = $row['matchedMaterialId'] ?? null;
        $material = $materials[(string)$materialId] ?? [];
        $intentId = $row['matchedIntentId'] ?? null;
        $insert->execute([
            row_id($row, 'chatLogs'),(string)($row['userId'] ?? ''),
            $row['courseId'] ?? $material['courseId'] ?? null,(string)($row['query'] ?? ''),
            $materialId,$intentId,(float)($row['confidence'] ?? 0),source_time($row['createdAt'] ?? null)
        ]);
        $counts['chat_logs']++;
    }

    $stage = 'assignments';
    $assignments = [];
    $insert = $pdo->prepare('INSERT INTO assignments (id,lecturer_id,course_id,course_title,course_code,lecturer_name,title,description,due_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    foreach (export_rows($source, 'assignments') as $row) {
        if (!is_array($row)) throw new RuntimeException('Invalid row in section "assignments".');
        $id = row_id($row, 'assignments');
        $insert->execute([
            $id,(string)($row['lecturerId'] ?? ''),(string)($row['courseId'] ?? ''),
            (string)($row['courseTitle'] ?? ''),(string)($row['courseCode'] ?? ''),
            (string)($row['lecturerName'] ?? ''),(string)($row['title'] ?? ''),
            (string)($row['description'] ?? ''),source_time($row['dueAt'] ?? null),
            source_time($row['createdAt'] ?? null)
        ]);
        $assignments[$id] = $row;
        $counts['assignments']++;
    }

    $stage = 'assignment_submissions';
    $insert = $pdo->prepare('INSERT INTO assignment_submissions (id,assignment_id,student_id,student_name,student_identifier,response,submitted_at,is_late,grade,feedback,graded_at,graded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    foreach (export_rows($source, 'assignmentSubmissions') as $row) {
        if (!is_array($row)) throw new RuntimeException('Invalid row in section "assignmentSubmissions".');
        $insert->execute([
            row_id($row, 'assignmentSubmissions'),(string)($row['assignmentId'] ?? ''),
            (string)($row['studentId'] ?? ''),(string)($row['studentName'] ?? ''),
            (string)($row['studentIdentifier'] ?? ''),(string)($row['response'] ?? ''),
            source_time($row['submittedAt'] ?? null),($row['late'] ?? false) ? 1 : 0,
            isset($row['grade']) ? (float)$row['grade'] : null,$row['feedback'] ?? null,
            source_time($row['gradedAt'] ?? null,true),$row['gradedBy'] ?? null
        ]);
        $counts['assignment_submissions']++;
    }

    $recordImport = $pdo->prepare('INSERT INTO migration_imports (source_sha256,imported_at,counts) VALUES (?,UTC_TIMESTAMP(3),?)');
    $recordImport->execute([$sourceHash,json_encode($counts, JSON_THROW_ON_ERROR)]);
    $pdo->commit();
} catch (Throwable $error) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    fail('Import failed during "' . ($stage ?? 'validation') . '"; all database changes were rolled back. Check the export, referenced upload files, and MySQL schema before retrying.');
}

fwrite(STDOUT, "Import completed. Existing account passwords were invalidated; users must use Forgot password after cutover." . PHP_EOL);
fwrite(STDOUT, json_encode($counts, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL);
