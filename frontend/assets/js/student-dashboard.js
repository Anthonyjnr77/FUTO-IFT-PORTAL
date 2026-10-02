(function() {
  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function showEmpty(container, message) {
    container.replaceChildren(node('div', 'overview-empty', message));
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

  function courseUrl(courseId) {
    return 'course.html?id=' + encodeURIComponent(courseId);
  }

  function makeItem(title, detail, state, href) {
    var item = node(href ? 'a' : 'div', 'overview-item');
    if (href) item.href = href;
    var copy = node('div');
    copy.append(node('strong', '', title), node('span', '', detail));
    item.appendChild(copy);
    if (state) item.appendChild(node('span', 'item-state', state));
    return item;
  }

  function renderAttention(assignments, quizzes, unreadCount) {
    var list = document.getElementById('attentionList');
    list.replaceChildren();
    var pending = assignments.filter(function(assignment) {
      return !assignment.submission;
    }).slice(0, 4);
    pending.forEach(function(assignment) {
      var dueTime = new Date(assignment.dueAt).getTime();
      var overdue = Number.isFinite(dueTime) && dueTime < Date.now();
      var dueLabel = overdue ? 'Overdue' : 'Due ' + formatDate(assignment.dueAt);
      list.appendChild(makeItem(
        assignment.courseCode + ' · ' + assignment.title,
        dueLabel + (assignment.description ? ' · ' + assignment.description.slice(0, 90) : ''),
        overdue ? 'Overdue' : 'To do',
        'assignments.html'
      ));
    });
    if (quizzes.length) {
      list.appendChild(makeItem(
        quizzes.length + ' quiz' + (quizzes.length === 1 ? '' : 'zes') + ' available',
        'Open the quiz list to review and take a course quiz.',
        'Available',
        'quiz.html'
      ));
    }
    if (unreadCount > 0) {
      list.appendChild(makeItem(
        unreadCount + ' unread update' + (unreadCount === 1 ? '' : 's'),
        'Check the latest messages and course announcements.',
        'Unread',
        'notifications.html'
      ));
    }
    if (!list.children.length) showEmpty(list, 'You’re all caught up. New work and updates will appear here.');
  }

  function renderClasses(courses) {
    var list = document.getElementById('todayClasses');
    list.replaceChildren();
    var today = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date()).toLowerCase();
    var classes = courses.filter(function(course) {
      return String(course.day || '').toLowerCase() === today;
    }).sort(function(a, b) {
      return String(a.startTime || '').localeCompare(String(b.startTime || ''));
    });
    classes.forEach(function(course) {
      var time = formatTime(course.startTime) + ' – ' + formatTime(course.endTime);
      list.appendChild(makeItem(
        course.courseCode + ' · ' + course.courseTitle,
        time + (course.room ? ' · ' + course.room : ''),
        course.room || 'Today',
        courseUrl(course.id)
      ));
    });
    if (!classes.length) showEmpty(list, 'No classes are listed for today.');
  }

  function renderCourses(courses) {
    var list = document.getElementById('studentCourseList');
    list.replaceChildren();
    courses.forEach(function(course) {
      var link = node('a', 'student-course');
      link.href = courseUrl(course.id);
      link.append(
        node('strong', '', course.courseCode),
        node('span', '', course.courseTitle),
        node('small', '', course.day + ' · ' + formatTime(course.startTime) + (course.room ? ' · ' + course.room : ''))
      );
      list.appendChild(link);
    });
    if (!courses.length) showEmpty(list, 'You are not enrolled in any courses yet. Browse My Courses to enroll.');
  }

  function notificationUrl(item) {
    if (item.courseId) return courseUrl(item.courseId);
    if (item.type === 'assignment') return 'assignments.html';
    if (item.type === 'quiz') return 'quiz.html';
    if (item.type === 'material') return 'course-materials.html';
    return 'notifications.html';
  }

  function renderUpdates(notifications) {
    var list = document.getElementById('recentUpdates');
    list.replaceChildren();
    notifications.slice(0, 5).forEach(function(item) {
      list.appendChild(makeItem(
        item.title || 'Course update',
        (item.body || '') + (item.createdAt ? ' · ' + formatDate(item.createdAt) : ''),
        item.readAt ? '' : 'New',
        notificationUrl(item)
      ));
    });
    if (!notifications.length) showEmpty(list, 'No course updates yet.');
  }

  function renderProgress(progress) {
    var container = document.getElementById('topicRecommendations');
    container.replaceChildren();
    var needsReview = progress.filter(function(item) { return item.masteryLevel === 'below_threshold'; });
    needsReview.slice(0, 5).forEach(function(item) {
      var card = node('article', 'topic-recommendation');
      card.appendChild(node('strong', '', item.courseCode + ' · ' + item.topicTag));
      card.appendChild(node('p', '', 'Latest score ' + item.lastScore + '%; mastery target ' + item.passThreshold + '%.'));
      if (item.recommendation && item.recommendation.material) {
        var material = item.recommendation.material;
        var link = node('a', '', 'Review ' + material.title);
        link.href = 'course.html?id=' + encodeURIComponent(item.courseId) + '#material-' + encodeURIComponent(material.id);
        card.appendChild(link);
      } else {
        card.appendChild(node('p', '', 'Ask your lecturer to share a resource tagged with this topic.'));
      }
      container.appendChild(card);
    });
    if (!needsReview.length) showEmpty(container, progress.length ? 'You are meeting the mastery targets for your recorded quiz topics.' : 'Complete a tagged quiz to get personalized topic guidance.');
  }

  function renderQuizHistory(results) {
    var list = document.getElementById('studentQuizHistory');
    list.replaceChildren();
    results.slice(0, 5).forEach(function(result) {
      list.appendChild(makeItem(
        result.courseCode + ' · ' + (result.quizTitle || 'Quiz'),
        (result.topicTag ? result.topicTag + ' · ' : '') + formatDate(result.date),
        result.score + '%',
        'quiz.html'
      ));
    });
    if (!results.length) showEmpty(list, 'Your completed lecturer quizzes will appear here.');
  }

  window.searchCourseResources = function(query) {
    return window.Auth.request('/student/chat', {
        method: 'POST',
        body: JSON.stringify({ query: query })
    });
  };

  document.addEventListener('DOMContentLoaded', async function() {
    var user = window.Auth.protect();
    if (!user) return;
    if (user.role === 'lecturer') {
      window.location.href = 'lecturer-dashboard.html';
      return;
    }

    var firstName = (user.name || 'Student').trim().split(/\s+/)[0];
    var hour = new Date().getHours();
    var greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    document.getElementById('greetingText').textContent = greeting + ', ' + firstName + '!';
    document.getElementById('navName').textContent = firstName;
    document.getElementById('navMatric').textContent = user.matric || '---';
    document.getElementById('currentDate').textContent = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
    try {
      var results = await Promise.all([
        window.Auth.request('/courses'),
        window.Auth.request('/assignments'),
        window.Auth.request('/quizzes'),
        window.Auth.request('/notifications'),
        window.Auth.request('/student/progress'),
        window.Auth.request('/student/quiz-results')
      ]);
      var courses = (results[0].courses || []).filter(function(course) { return course.enrolled; });
      var assignments = results[1].assignments || [];
      var quizzes = results[2].quizzes || [];
      var notifications = results[3].notifications || [];
      var progress = results[4].progress || [];
      var quizHistory = results[5].results || [];
      var unreadCount = Number(results[3].unreadCount) || 0;
      var pendingCount = assignments.filter(function(assignment) { return !assignment.submission; }).length;

      document.getElementById('overviewCourseCount').textContent = courses.length;
      document.getElementById('overviewAssignmentCount').textContent = pendingCount;
      document.getElementById('overviewQuizCount').textContent = quizzes.length;
      document.getElementById('overviewUnreadCount').textContent = unreadCount;
      renderAttention(assignments, quizzes, unreadCount);
      renderClasses(courses);
      renderCourses(courses);
      renderUpdates(notifications);
      renderProgress(progress);
      renderQuizHistory(quizHistory);

      var countBadge = document.getElementById('notificationCount');
      countBadge.hidden = unreadCount === 0;
      countBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
      document.getElementById('notificationLink').setAttribute(
        'aria-label',
        unreadCount ? 'Notifications, ' + unreadCount + ' unread' : 'Notifications'
      );
    } catch (error) {
      var errorBox = document.getElementById('overviewError');
      errorBox.textContent = 'Student information could not be loaded: ' + error.message;
      errorBox.hidden = false;
      showEmpty(document.getElementById('attentionList'), 'Assignments and updates are unavailable until the connection is restored.');
      showEmpty(document.getElementById('todayClasses'), 'Your schedule is unavailable.');
      showEmpty(document.getElementById('studentCourseList'), 'Your enrolled courses are unavailable.');
      showEmpty(document.getElementById('recentUpdates'), 'Your updates are unavailable.');
      showEmpty(document.getElementById('topicRecommendations'), 'Your learning progress is unavailable until you sign in again.');
      showEmpty(document.getElementById('studentQuizHistory'), 'Your quiz history is unavailable until you sign in again.');
    }
  });
}());
