const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createHash, randomBytes } = require('node:crypto');
const test = require('node:test');

function availablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function requestJson(baseUrl, route, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  }).then(async response => ({
    status: response.status,
    body: await response.json()
  }));
}

test('admin can create lecturer accounts without granting students lecturer access', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'futo-ift-api-test-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const adminUsername = `test-admin-${randomBytes(4).toString('hex')}`;
  const adminPassword = randomBytes(24).toString('hex');
  const lecturerUsername = `test-lecturer-${randomBytes(4).toString('hex')}`;
  const lecturerEmail = `${lecturerUsername}@example.test`;
  const lecturerPassword = randomBytes(24).toString('hex');
  const studentEmail = `test-student-${randomBytes(4).toString('hex')}@example.test`;
  const studentPassword = randomBytes(24).toString('hex');
  let serverErrors = '';
  const serverEnvironment = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    PORTAL_DATA_DIR: dataDir,
    CLIENT_URL: baseUrl,
    DATABASE_URL: '',
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    ADMIN_USERNAME: adminUsername,
    ADMIN_PASSWORD: adminPassword,
    ADMIN_EMAIL: '',
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: ''
  };
  const startServer = () => spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: serverEnvironment,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  const attachErrorCapture = serverProcess => {
    serverErrors = '';
    serverProcess.stderr.setEncoding('utf8');
    serverProcess.stderr.on('data', chunk => { serverErrors += chunk; });
    return serverProcess;
  };
  const waitForHealth = async serverProcess => {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (serverProcess.exitCode !== null) return false;
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) return true;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return false;
  };
  const stopServer = async serverProcess => {
    if (serverProcess.exitCode === null) {
      const exited = once(serverProcess, 'exit');
      serverProcess.kill();
      await exited;
    }
  };
  let server = attachErrorCapture(startServer());

  t.after(async () => {
    await stopServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  assert.equal(await waitForHealth(server), true, `isolated API server should start and pass its health check: ${serverErrors}`);

  const deniedAdminList = await requestJson(baseUrl, '/api/admin/users');
  assert.equal(deniedAdminList.status, 401);

  const publicLecturerRegistration = await requestJson(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { role: 'lecturer' }
  });
  assert.equal(publicLecturerRegistration.status, 403);

  const adminLogin = await requestJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { role: 'admin', username: adminUsername, password: adminPassword }
  });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.body.user.role, 'admin');

  const createLecturer = await requestJson(baseUrl, '/api/admin/users', {
    method: 'POST',
    token: adminLogin.body.token,
    body: {
      name: 'Test Lecturer',
      email: lecturerEmail,
      role: 'lecturer',
      identifier: lecturerUsername,
      password: lecturerPassword
    }
  });
  assert.equal(createLecturer.status, 201);
  assert.equal(createLecturer.body.user.role, 'lecturer');

  const lecturerLogin = await requestJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: {
      role: 'lecturer',
      username: lecturerUsername,
      email: lecturerEmail,
      password: lecturerPassword
    }
  });
  assert.equal(lecturerLogin.status, 200);
  assert.equal(lecturerLogin.body.user.role, 'lecturer');

  const createdCourse = await requestJson(baseUrl, '/api/lecturer/courses', {
    method: 'POST',
    token: lecturerLogin.body.token,
    body: {
      courseCode: 'IFT 101',
      courseTitle: 'Introduction to Information Technology',
      level: '100',
      day: 'Monday',
      startTime: '09:00',
      endTime: '10:00',
      room: 'Room A'
    }
  });
  assert.equal(createdCourse.status, 201);

  const studentRegistration = await requestJson(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Test Student',
      email: studentEmail,
      matric: `202${(randomBytes(4).readUInt32BE(0) % 100000000).toString().padStart(8, '0')}`,
      level: '100',
      password: studentPassword
    }
  });
  assert.equal(studentRegistration.status, 201);

  const enrolled = await requestJson(baseUrl, `/api/courses/${createdCourse.body.course.id}/enroll`, {
    method: 'POST',
    token: studentRegistration.body.token
  });
  assert.equal(enrolled.status, 200);

  const courseMaterial = await requestJson(baseUrl, '/api/lecturer/materials', {
    method: 'POST',
    token: lecturerLogin.body.token,
    body: {
      courseId: createdCourse.body.course.id,
      title: 'Introduction to computing',
      topicTag: 'Computer fundamentals',
      fileName: 'fundamentals.txt',
      contentBase64: Buffer.from('Course reading material for computer fundamentals.').toString('base64')
    }
  });
  assert.equal(courseMaterial.status, 201);

  const courseChatResult = await requestJson(baseUrl, '/api/student/chat', {
    method: 'POST',
    token: studentRegistration.body.token,
    body: { query: 'Could you please explain computer fundamentals?' }
  });
  assert.equal(courseChatResult.status, 200);
  assert.equal(courseChatResult.body.resource.title, 'Introduction to computing');
  assert.equal(courseChatResult.body.resource.courseId, createdCourse.body.course.id);
  assert.match(courseChatResult.body.resource.courseUrl, /#material-/);

  const unmatchedCourseChat = await requestJson(baseUrl, '/api/student/chat', {
    method: 'POST',
    token: studentRegistration.body.token,
    body: { query: 'unrelated topic with no course resource match' }
  });
  assert.equal(unmatchedCourseChat.status, 200);
  assert.equal(unmatchedCourseChat.body.resource, null);
  assert.match(unmatchedCourseChat.body.answer, /could not find a confident match/i);

  const publishedQuiz = await requestJson(baseUrl, '/api/lecturer/quizzes', {
    method: 'POST',
    token: lecturerLogin.body.token,
    body: {
      courseId: createdCourse.body.course.id,
      title: 'Computer fundamentals check',
      topicTag: 'Computer fundamentals',
      passThreshold: 70,
      durationMinutes: 10,
      questions: [
        { q: 'Which device processes instructions?', opts: ['CPU', 'Monitor'], ans: 0 },
        { q: 'Which component stores data temporarily?', opts: ['RAM', 'Printer'], ans: 0 }
      ]
    }
  });
  assert.equal(publishedQuiz.status, 201);
  const studentQuizzes = await requestJson(baseUrl, '/api/quizzes', {
    token: studentRegistration.body.token
  });
  assert.equal(studentQuizzes.status, 200);
  assert.equal(studentQuizzes.body.quizzes[0].level, '100');

  const unregisteredChatAccess = await requestJson(baseUrl, '/api/student/chat', {
    method: 'POST',
    body: { query: 'Explain computer fundamentals' }
  });
  assert.equal(unregisteredChatAccess.status, 401);

  const pastQuestion = async (topicTag, examYear, questionText) => requestJson(baseUrl, '/api/past-questions', {
    method: 'POST',
    token: lecturerLogin.body.token,
    body: {
      courseId: createdCourse.body.course.id,
      topicTag,
      examYear,
      questionText
    }
  });
  const currentYear = new Date().getFullYear();
  const firstQuestion = await pastQuestion('Computer fundamentals', currentYear, 'Explain the difference between system and application software.');
  const repeatedQuestion = await pastQuestion('Computer fundamentals', currentYear - 1, 'Describe the main functional units of a computer system.');
  const otherQuestion = await pastQuestion('Number systems', currentYear, 'Convert the given binary value to its decimal equivalent.');
  assert.equal(firstQuestion.status, 201);
  assert.equal(repeatedQuestion.status, 201);
  assert.equal(otherQuestion.status, 201);
  const lecturerQuestionList = await requestJson(baseUrl, '/api/past-questions', {
    token: lecturerLogin.body.token
  });
  assert.equal(lecturerQuestionList.status, 200);
  assert.equal(lecturerQuestionList.body.pastQuestions.length, 3);
  assert.equal(lecturerQuestionList.body.courses[0].id, createdCourse.body.course.id);

  const studentPastQuestionAccess = await requestJson(baseUrl, '/api/past-questions', {
    token: studentRegistration.body.token
  });
  assert.equal(studentPastQuestionAccess.status, 401);

  const initialReadingProgress = await requestJson(baseUrl, '/api/student/reading-progress', {
    token: studentRegistration.body.token
  });
  assert.equal(initialReadingProgress.status, 200);
  assert.equal(initialReadingProgress.body.readings.length, 1);
  assert.equal(initialReadingProgress.body.readings[0].status, 'not_started');

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const updatedReadingProgress = await requestJson(baseUrl, '/api/student/reading-progress', {
    method: 'POST',
    token: studentRegistration.body.token,
    body: {
      materialId: courseMaterial.body.material.id,
      status: 'in_progress',
      targetDate: yesterday
    }
  });
  assert.equal(updatedReadingProgress.status, 200);
  assert.equal(updatedReadingProgress.body.reading.status, 'in_progress');
  assert.equal(updatedReadingProgress.body.reading.targetDate, yesterday);
  const invalidReadingDate = await requestJson(baseUrl, '/api/student/reading-progress', {
    method: 'POST',
    token: studentRegistration.body.token,
    body: {
      materialId: courseMaterial.body.material.id,
      status: 'in_progress',
      targetDate: '2026-02-30'
    }
  });
  assert.equal(invalidReadingDate.status, 400);

  const prioritizedPredictions = await requestJson(baseUrl, '/api/student/exam-predictions', {
    token: studentRegistration.body.token
  });
  assert.equal(prioritizedPredictions.status, 200);
  assert.equal(prioritizedPredictions.body.recommendations[0].topicTag, 'Computer fundamentals');
  assert.equal(prioritizedPredictions.body.recommendations[0].questionCount, 2);
  assert.equal(prioritizedPredictions.body.recommendations[0].priority, true);

  const completedReadingProgress = await requestJson(baseUrl, '/api/student/reading-progress', {
    method: 'POST',
    token: studentRegistration.body.token,
    body: { materialId: courseMaterial.body.material.id, status: 'completed', targetDate: null }
  });
  assert.equal(completedReadingProgress.status, 200);
  const completedTopicPredictions = await requestJson(baseUrl, '/api/student/exam-predictions', {
    token: studentRegistration.body.token
  });
  const completedTopic = completedTopicPredictions.body.recommendations.find(item => item.topicTag === 'Computer fundamentals');
  assert.equal(completedTopic.priority, false);

  const studentLecturerPage = await requestJson(baseUrl, '/api/lecturer/courses', {
    token: studentRegistration.body.token
  });
  assert.equal(studentLecturerPage.status, 401);

  const lecturerCourses = await requestJson(baseUrl, '/api/lecturer/courses', {
    token: lecturerLogin.body.token
  });
  assert.equal(lecturerCourses.status, 200);

  await stopServer(server);
  server = attachErrorCapture(startServer());
  assert.equal(await waitForHealth(server), true, `API should restart using the same isolated database directory: ${serverErrors}`);
  const restoredLecturerSession = await requestJson(baseUrl, '/api/lecturer/courses', {
    token: lecturerLogin.body.token
  });
  assert.equal(restoredLecturerSession.status, 200, 'lecturer session should remain valid after a server restart');
  const stillDeniedStudentSession = await requestJson(baseUrl, '/api/lecturer/courses', {
    token: studentRegistration.body.token
  });
  assert.equal(stillDeniedStudentSession.status, 401, 'student session must remain blocked from lecturer routes after a restart');

  await stopServer(server);
  const statePath = path.join(dataDir, 'db.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const migratedLecturer = state.users.find(user => user.email === lecturerEmail);
  const resetToken = randomBytes(32).toString('hex');
  migratedLecturer.passwordResetRequired = true;
  migratedLecturer.resetTokenHash = createHash('sha256').update(resetToken).digest('hex');
  migratedLecturer.resetTokenExpiresAt = Date.now() + 30 * 60 * 1000;
  fs.writeFileSync(statePath, JSON.stringify(state));

  server = attachErrorCapture(startServer());
  assert.equal(await waitForHealth(server), true, `API should start with migrated users requiring a reset: ${serverErrors}`);
  const blockedMigratedLogin = await requestJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: {
      role: 'lecturer',
      username: lecturerUsername,
      email: lecturerEmail,
      password: lecturerPassword
    }
  });
  assert.equal(blockedMigratedLogin.status, 403);
  assert.equal(blockedMigratedLogin.body.passwordResetRequired, true);

  const completedPasswordReset = await requestJson(baseUrl, '/api/auth/reset-password', {
    method: 'POST',
    body: { token: resetToken, password: studentPassword }
  });
  assert.equal(completedPasswordReset.status, 200);

  const loginWithOldPassword = await requestJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: {
      role: 'lecturer',
      username: lecturerUsername,
      email: lecturerEmail,
      password: lecturerPassword
    }
  });
  assert.equal(loginWithOldPassword.status, 401);

  const loginWithNewPassword = await requestJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: {
      role: 'lecturer',
      username: lecturerUsername,
      email: lecturerEmail,
      password: studentPassword
    }
  });
  assert.equal(loginWithNewPassword.status, 200);
});
