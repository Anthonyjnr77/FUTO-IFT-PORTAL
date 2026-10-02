CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  identifier VARCHAR(80) NOT NULL,
  email VARCHAR(254) NULL,
  name VARCHAR(100) NOT NULL,
  role ENUM('student', 'lecturer', 'admin') NOT NULL,
  dept VARCHAR(80) NULL,
  level VARCHAR(3) NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  reset_token_hash CHAR(64) NULL,
  reset_token_expires_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY users_identifier (identifier),
  UNIQUE KEY users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  KEY sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS taught_courses (
  id CHAR(36) PRIMARY KEY,
  lecturer_id CHAR(36) NOT NULL,
  course_code VARCHAR(20) NOT NULL,
  course_title VARCHAR(120) NOT NULL,
  level VARCHAR(3) NOT NULL,
  day VARCHAR(9) NOT NULL,
  start_time CHAR(5) NOT NULL,
  end_time CHAR(5) NOT NULL,
  room VARCHAR(80) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT courses_lecturer_fk FOREIGN KEY (lecturer_id) REFERENCES users(id),
  KEY courses_level (level),
  KEY courses_lecturer (lecturer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS course_enrollments (
  student_id CHAR(36) NOT NULL,
  course_id CHAR(36) NOT NULL,
  enrolled_at DATETIME(3) NOT NULL,
  added_by CHAR(36) NULL,
  PRIMARY KEY (student_id, course_id),
  CONSTRAINT enrollments_student_fk FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT enrollments_course_fk FOREIGN KEY (course_id) REFERENCES taught_courses(id) ON DELETE CASCADE,
  CONSTRAINT enrollments_added_by_fk FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL,
  KEY enrollments_course (course_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  course_id CHAR(36) NULL,
  title VARCHAR(180) NOT NULL,
  body TEXT NOT NULL,
  type VARCHAR(40) NOT NULL,
  reference_id CHAR(36) NULL,
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT notifications_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT notifications_course_fk FOREIGN KEY (course_id) REFERENCES taught_courses(id) ON DELETE SET NULL,
  KEY notifications_user_date (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS course_announcements (
  id CHAR(36) PRIMARY KEY,
  lecturer_id CHAR(36) NOT NULL,
  course_id CHAR(36) NOT NULL,
  course_code VARCHAR(20) NOT NULL,
  course_title VARCHAR(120) NOT NULL,
  lecturer_name VARCHAR(100) NOT NULL,
  title VARCHAR(160) NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT announcements_lecturer_fk FOREIGN KEY (lecturer_id) REFERENCES users(id),
  CONSTRAINT announcements_course_fk FOREIGN KEY (course_id) REFERENCES taught_courses(id) ON DELETE CASCADE,
  KEY announcements_course_date (course_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS course_materials (
  id CHAR(36) PRIMARY KEY,
  lecturer_id CHAR(36) NOT NULL,
  lecturer_name VARCHAR(100) NOT NULL,
  course_id CHAR(36) NOT NULL,
  course_code VARCHAR(20) NOT NULL,
  course_title VARCHAR(120) NOT NULL,
  level VARCHAR(3) NOT NULL,
  title VARCHAR(160) NOT NULL,
  topic_tag VARCHAR(100) NOT NULL,
  resource_type ENUM('file', 'video') NOT NULL DEFAULT 'file',
  file_name VARCHAR(255) NULL,
  content_type VARCHAR(120) NULL,
  size_bytes INT UNSIGNED NULL,
  file_data LONGBLOB NULL,
  resource_url VARCHAR(2048) NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT materials_lecturer_fk FOREIGN KEY (lecturer_id) REFERENCES users(id),
  CONSTRAINT materials_course_fk FOREIGN KEY (course_id) REFERENCES taught_courses(id) ON DELETE CASCADE,
  KEY materials_course_topic (course_id, topic_tag),
  KEY materials_lecturer (lecturer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quizzes (
  id CHAR(36) PRIMARY KEY,
  lecturer_id CHAR(36) NOT NULL,
  course_id CHAR(36) NOT NULL,
  course_code VARCHAR(20) NOT NULL,
  course_title VARCHAR(120) NOT NULL,
  lecturer_name VARCHAR(100) NOT NULL,
  title VARCHAR(120) NOT NULL,
  topic_tag VARCHAR(100) NOT NULL,
  pass_threshold TINYINT UNSIGNED NOT NULL,
  duration_minutes SMALLINT UNSIGNED NOT NULL,
  questions JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT quizzes_lecturer_fk FOREIGN KEY (lecturer_id) REFERENCES users(id),
  CONSTRAINT quizzes_course_fk FOREIGN KEY (course_id) REFERENCES taught_courses(id) ON DELETE CASCADE,
  KEY quizzes_course (course_id),
  KEY quizzes_lecturer (lecturer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id CHAR(36) PRIMARY KEY,
  quiz_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  submitted_at DATETIME(3) NULL,
  score TINYINT UNSIGNED NULL,
  CONSTRAINT attempts_quiz_fk FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE,
  CONSTRAINT attempts_student_fk FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
  KEY attempts_student_quiz (student_id, quiz_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS quiz_results (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  course_id CHAR(36) NULL,
  quiz_id CHAR(36) NULL,
  course_code VARCHAR(20) NOT NULL,
  quiz_title VARCHAR(160) NULL,
  topic_tag VARCHAR(100) NULL,
  pass_threshold TINYINT UNSIGNED NULL,
  answers JSON NULL,
  score TINYINT UNSIGNED NOT NULL,
  correct_count SMALLINT UNSIGNED NULL,
  question_count SMALLINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT results_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT results_course_fk FOREIGN KEY (course_id) REFERENCES taught_courses(id) ON DELETE SET NULL,
  CONSTRAINT results_quiz_fk FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE SET NULL,
  KEY results_user_date (user_id, created_at),
  KEY results_quiz (quiz_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS progress_logs (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  course_id CHAR(36) NOT NULL,
  course_code VARCHAR(20) NOT NULL,
  topic_tag VARCHAR(100) NOT NULL,
  pass_threshold TINYINT UNSIGNED NOT NULL,
  attempt_count INT UNSIGNED NOT NULL,
  total_score INT UNSIGNED NOT NULL,
  average_score TINYINT UNSIGNED NOT NULL,
  last_score TINYINT UNSIGNED NOT NULL,
  mastery_level ENUM('mastered', 'below_threshold') NOT NULL,
  last_updated DATETIME(3) NOT NULL,
  CONSTRAINT progress_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT progress_course_fk FOREIGN KEY (course_id) REFERENCES taught_courses(id) ON DELETE CASCADE,
  UNIQUE KEY progress_user_course_topic (user_id, course_id, topic_tag),
  KEY progress_user_date (user_id, last_updated)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_intents (
  id CHAR(36) PRIMARY KEY,
  topic_tag VARCHAR(100) NOT NULL,
  explanation VARCHAR(500) NOT NULL,
  sample_phrases JSON NOT NULL,
  linked_material_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT intents_material_fk FOREIGN KEY (linked_material_id) REFERENCES course_materials(id) ON DELETE CASCADE,
  KEY intents_topic (topic_tag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_logs (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  course_id CHAR(36) NULL,
  query_text VARCHAR(500) NOT NULL,
  matched_material_id CHAR(36) NULL,
  matched_intent_id CHAR(36) NULL,
  confidence DECIMAL(5,4) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT chat_logs_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chat_logs_course_fk FOREIGN KEY (course_id) REFERENCES taught_courses(id) ON DELETE SET NULL,
  CONSTRAINT chat_logs_material_fk FOREIGN KEY (matched_material_id) REFERENCES course_materials(id) ON DELETE SET NULL,
  CONSTRAINT chat_logs_intent_fk FOREIGN KEY (matched_intent_id) REFERENCES chat_intents(id) ON DELETE SET NULL,
  KEY chat_logs_course_date (course_id, created_at),
  KEY chat_logs_user_date (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assignments (
  id CHAR(36) PRIMARY KEY,
  lecturer_id CHAR(36) NOT NULL,
  course_id CHAR(36) NOT NULL,
  course_title VARCHAR(120) NOT NULL,
  course_code VARCHAR(20) NOT NULL,
  lecturer_name VARCHAR(100) NOT NULL,
  title VARCHAR(120) NOT NULL,
  description TEXT NOT NULL,
  due_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT assignments_lecturer_fk FOREIGN KEY (lecturer_id) REFERENCES users(id),
  CONSTRAINT assignments_course_fk FOREIGN KEY (course_id) REFERENCES taught_courses(id) ON DELETE CASCADE,
  KEY assignments_course_due (course_id, due_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assignment_submissions (
  id CHAR(36) PRIMARY KEY,
  assignment_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  student_name VARCHAR(100) NOT NULL,
  student_identifier VARCHAR(80) NOT NULL,
  response TEXT NOT NULL,
  submitted_at DATETIME(3) NOT NULL,
  is_late TINYINT(1) NOT NULL DEFAULT 0,
  grade DECIMAL(5,2) UNSIGNED NULL,
  feedback VARCHAR(3000) NULL,
  graded_at DATETIME(3) NULL,
  graded_by VARCHAR(100) NULL,
  CONSTRAINT submissions_assignment_fk FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
  CONSTRAINT submissions_student_fk FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY submissions_assignment_student (assignment_id, student_id),
  KEY submissions_student (student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS migration_imports (
  source_sha256 CHAR(64) PRIMARY KEY,
  imported_at DATETIME(3) NOT NULL,
  counts JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
