(function() {
  var notice = document.getElementById('notice');

  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function formatDate(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Date unavailable';
    return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function formatTime(value) {
    if (!value) return 'Time unavailable';
    var parts = value.split(':');
    var date = new Date();
    date.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function showNotice(message, kind) {
    notice.textContent = message;
    notice.className = 'notice show ' + kind;
  }

  function showEmpty(id, message) {
    document.getElementById(id).replaceChildren(node('div', 'empty', message));
  }

  function appendAction(container, label, href) {
    var link = node('a', 'item-action', label);
    link.href = href;
    container.appendChild(link);
  }

  function renderAnnouncements(announcements) {
    var list = document.getElementById('announcementList');
    list.replaceChildren();
    announcements.slice(0, 8).forEach(function(announcement) {
      var card = node('article', 'content-item');
      card.appendChild(node('strong', '', announcement.title));
      card.appendChild(node('p', '', announcement.body));
      card.appendChild(node('div', 'content-meta', (announcement.lecturerName || 'Lecturer') + ' · ' + formatDate(announcement.createdAt)));
      list.appendChild(card);
    });
    if (!announcements.length) showEmpty('announcementList', 'No announcements have been posted for this course.');
  }

  function renderMaterials(materials) {
    var list = document.getElementById('materialList');
    list.replaceChildren();
    materials.forEach(function(material) {
      var card = node('article', 'content-item');
      card.id = 'material-' + material.id;
      card.appendChild(node('strong', '', material.title));
      card.appendChild(node('div', 'content-meta', (material.topicTag || 'Course resource') + ' · ' + (material.resourceType === 'video' ? 'Video link' : material.fileName) + ' · Added ' + formatDate(material.createdAt)));
      var button = node('button', 'download-button', material.resourceType === 'video' ? 'Watch video' : 'Download material');
      button.type = 'button';
      button.addEventListener('click', function() {
        downloadMaterial(material, button);
      });
      card.appendChild(button);
      list.appendChild(card);
    });
    if (!materials.length) showEmpty('materialList', 'No course materials have been shared yet.');
  }

  async function downloadMaterial(material, button) {
    if (material.resourceType === 'video' && material.resourceUrl) {
      window.open(material.resourceUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    button.disabled = true;
    try {
      var token = localStorage.getItem('futo_token') || sessionStorage.getItem('futo_token');
      var response = await fetch(window.Auth.apiBase + '/materials/' + encodeURIComponent(material.id) + '/download', {
        headers: token ? { Authorization: 'Bearer ' + token } : {}
      });
      if (!response.ok) {
        var body = await response.json();
        throw new Error(body.error || 'The material could not be downloaded.');
      }
      var objectUrl = URL.createObjectURL(await response.blob());
      var link = node('a');
      link.href = objectUrl;
      link.download = material.fileName || material.title;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(function() { URL.revokeObjectURL(objectUrl); }, 1000);
    } catch (error) {
      showNotice(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function renderAssignments(assignments) {
    var list = document.getElementById('assignmentList');
    list.replaceChildren();
    assignments.forEach(function(assignment) {
      var card = node('article', 'content-item');
      var submission = assignment.submission;
      var status = !submission ? 'Not submitted' : submission.grade !== undefined ? 'Graded · ' + submission.grade + '/100' : 'Submitted';
      card.appendChild(node('strong', '', assignment.title));
      card.appendChild(node('p', '', assignment.description));
      card.appendChild(node('div', 'content-meta', 'Due ' + formatDate(assignment.dueAt) + ' · ' + status));
      if (submission && submission.feedback) card.appendChild(node('p', '', 'Lecturer feedback: ' + submission.feedback));
      appendAction(card, 'Open assignments', 'assignments.html');
      list.appendChild(card);
    });
    if (!assignments.length) showEmpty('assignmentList', 'No assignments have been posted for this course.');
  }

  function renderQuizzes(quizzes) {
    var list = document.getElementById('quizList');
    list.replaceChildren();
    quizzes.forEach(function(quiz) {
      var card = node('article', 'content-item');
      card.appendChild(node('strong', '', quiz.title));
      card.appendChild(node('div', 'content-meta', (quiz.topicTag ? quiz.topicTag + ' · ' : '') + quiz.questionCount + ' questions · ' + quiz.durationMinutes + ' minutes · Mastery target ' + quiz.passThreshold + '%'));
      appendAction(card, 'Start quiz', 'take-quiz.html?id=' + encodeURIComponent(quiz.id));
      list.appendChild(card);
    });
    if (!quizzes.length) showEmpty('quizList', 'No quizzes have been published for this course.');
  }

  document.addEventListener('DOMContentLoaded', async function() {
    var user = window.Auth.protect();
    if (!user) return;
    if (user.role === 'lecturer') {
      window.location.href = 'lecturer-dashboard.html';
      return;
    }

    var courseId = new URLSearchParams(window.location.search).get('id');
    if (!courseId) {
      showNotice('No course was selected. Choose an enrolled course from My Courses.', 'error');
      return;
    }

    try {
      var results = await Promise.all([
        window.Auth.request('/courses'),
        window.Auth.request('/materials'),
        window.Auth.request('/assignments'),
        window.Auth.request('/quizzes'),
        window.Auth.request('/announcements')
      ]);
      var course = (results[0].courses || []).find(function(item) {
        return item.id === courseId && item.enrolled;
      });
      if (!course) {
        showNotice('This course is not enrolled or is not available to your account.', 'error');
        showEmpty('announcementList', 'Course content is only available to enrolled students.');
        showEmpty('materialList', 'Course content is only available to enrolled students.');
        showEmpty('assignmentList', 'Course content is only available to enrolled students.');
        showEmpty('quizList', 'Course content is only available to enrolled students.');
        return;
      }

      document.title = course.courseCode + ' | FUTO IFT';
      document.getElementById('courseCode').textContent = course.courseCode + ' · ' + course.level + ' Level';
      document.getElementById('courseTitle').textContent = course.courseTitle;
      document.getElementById('courseMeta').replaceChildren(
        node('span', '', 'Lecturer: ' + (course.lecturerName || 'Lecturer')),
        node('span', '', 'Course home')
      );
      document.getElementById('scheduleInfo').textContent =
        course.day + ' · ' + formatTime(course.startTime) + ' – ' + formatTime(course.endTime) +
        (course.room ? ' · ' + course.room : '');

      renderAnnouncements((results[4].announcements || []).filter(function(item) { return item.courseId === courseId; }));
      renderMaterials((results[1].materials || []).filter(function(item) { return item.courseId === courseId; }));
      renderAssignments((results[2].assignments || []).filter(function(item) { return item.courseId === courseId; }));
      renderQuizzes((results[3].quizzes || []).filter(function(item) {
        return item.courseId ? item.courseId === courseId : item.courseCode === course.courseCode;
      }));
      if (window.location.hash) {
        var target = document.getElementById(window.location.hash.slice(1));
        if (target) target.scrollIntoView();
      }
    } catch (error) {
      showNotice('Course information could not be loaded: ' + error.message, 'error');
      showEmpty('announcementList', 'Announcements could not be loaded.');
      showEmpty('materialList', 'Materials could not be loaded.');
      showEmpty('assignmentList', 'Assignments could not be loaded.');
      showEmpty('quizList', 'Quizzes could not be loaded.');
    }
  });
}());
