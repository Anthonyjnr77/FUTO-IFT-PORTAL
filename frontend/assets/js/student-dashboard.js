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
        node('small', '', course.day && course.startTime && course.endTime
          ? course.day + ' · ' + formatTime(course.startTime) + ' – ' + formatTime(course.endTime) + (course.room ? ' · ' + course.room : '')
          : course.semester + ' Semester · Schedule not published')
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
    var topics = progress.slice().sort(function(a, b) {
      var aBelow = a.masteryLevel === 'below_threshold';
      var bBelow = b.masteryLevel === 'below_threshold';
      return Number(bBelow) - Number(aBelow) ||
        Number(a.averageScore || a.lastScore || 0) - Number(b.averageScore || b.lastScore || 0) ||
        String(a.courseCode || '').localeCompare(String(b.courseCode || '')) ||
        String(a.topicTag || '').localeCompare(String(b.topicTag || ''));
    });
    topics.forEach(function(item) {
      var belowThreshold = item.masteryLevel === 'below_threshold';
      var averageScore = Number.isFinite(Number(item.averageScore)) ? Number(item.averageScore) : Number(item.lastScore);
      var latestScore = Number(item.lastScore);
      var threshold = Number(item.passThreshold);
      var safeAverage = Number.isFinite(averageScore) ? Math.max(0, Math.min(100, averageScore)) : 0;
      var card = node('article', 'topic-performance' + (belowThreshold ? ' is-below' : ''));
      var heading = node('div', 'topic-performance-head');
      var identity = node('div');
      identity.append(
        node('strong', '', (item.courseCode || 'Course') + ' · ' + (item.topicTag || 'Untagged topic')),
        node('small', '', (item.courseTitle || 'Recorded quiz topic') +
          (Number(item.attemptCount) > 0 ? ' · ' + item.attemptCount + ' attempt' + (Number(item.attemptCount) === 1 ? '' : 's') : ''))
      );
      heading.append(identity, node(
        'span',
        'topic-mastery' + (belowThreshold ? ' is-below' : ''),
        belowThreshold ? 'Needs review' : 'Mastery met'
      ));
      card.appendChild(heading);

      var scoreText = Number.isFinite(averageScore) ? 'Average ' + Math.round(averageScore) + '%' : 'Average unavailable';
      scoreText += Number.isFinite(latestScore) ? ' · Latest ' + Math.round(latestScore) + '%' : '';
      scoreText += Number.isFinite(threshold) ? ' · Target ' + Math.round(threshold) + '%' : '';
      card.appendChild(node('div', 'topic-score-copy', scoreText));

      var track = node('div', 'topic-score-track');
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', 'Average score for ' + (item.topicTag || 'topic'));
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(Math.round(safeAverage)));
      var fill = node('div', 'topic-score-fill');
      fill.style.width = safeAverage + '%';
      track.appendChild(fill);
      card.appendChild(track);

      if (belowThreshold) {
        if (item.recommendation && item.recommendation.material) {
          var material = item.recommendation.material;
          var link = node('a', 'topic-review-link', 'Review ' + material.title);
          link.href = 'course.html?id=' + encodeURIComponent(item.courseId) + '#material-' + encodeURIComponent(material.id);
          card.appendChild(link);
        } else {
          card.appendChild(node('p', 'topic-review-note', 'Ask your lecturer to share a resource tagged with this topic.'));
        }
      }
      container.appendChild(card);
    });
    if (!topics.length) showEmpty(container, 'Complete a tagged quiz to get personalized topic performance and mastery guidance.');
  }

  function localDateKey(date) {
    return date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0');
  }

  function readingStatusLabel(status) {
    if (status === 'completed') return 'Read';
    if (status === 'in_progress') return 'In progress';
    return 'Outstanding';
  }

  function renderReadingProgress(readings) {
    var summary = document.getElementById('readingSummaryStats');
    var list = document.getElementById('readingProgressList');
    var today = localDateKey(new Date());
    var completedCount = readings.filter(function(item) { return item.status === 'completed'; }).length;
    var overdueCount = readings.filter(function(item) {
      return item.status !== 'completed' && item.targetDate && item.targetDate < today;
    }).length;
    var values = [
      [readings.length, 'Materials'],
      [completedCount, 'Completed'],
      [readings.length - completedCount, 'Outstanding'],
      [overdueCount, 'Overdue']
    ];
    summary.replaceChildren();
    values.forEach(function(value) {
      var stat = node('div', 'reading-summary-stat');
      stat.append(node('strong', '', String(value[0])), node('span', '', value[1]));
      summary.appendChild(stat);
    });

    list.replaceChildren();
    var orderedReadings = readings.slice().sort(function(a, b) {
      function priority(item) {
        if (item.status !== 'completed' && item.targetDate && item.targetDate < today) return 0;
        if (item.status === 'in_progress') return 1;
        if (item.status !== 'completed') return 2;
        return 3;
      }
      return priority(a) - priority(b) ||
        String(a.targetDate || '9999-12-31').localeCompare(String(b.targetDate || '9999-12-31')) ||
        String(a.material && a.material.title || '').localeCompare(String(b.material && b.material.title || ''));
    });
    orderedReadings.forEach(function(item) {
      var material = item.material || {};
      var overdue = item.status !== 'completed' && item.targetDate && item.targetDate < today;
      var link = node('a', 'reading-item');
      link.href = 'course.html?id=' + encodeURIComponent(material.courseId || '') +
        '#material-' + encodeURIComponent(material.id || '');
      var copy = node('div', 'reading-item-copy');
      copy.append(
        node('strong', '', material.title || 'Course material'),
        node('span', '', (material.courseCode || 'Course') + ' · ' + (material.topicTag || 'Untagged topic'))
      );
      if (item.targetDate) {
        var target = new Date(item.targetDate + 'T00:00:00');
        copy.appendChild(node('span', '', 'Target date: ' + target.toLocaleDateString([], {
          day: 'numeric', month: 'short', year: 'numeric'
        })));
      }
      link.append(copy, node(
        'span',
        'reading-status' + (overdue ? ' is-overdue' : ''),
        overdue ? 'Overdue' : readingStatusLabel(item.status)
      ));
      list.appendChild(link);
    });
    if (!orderedReadings.length) showEmpty(list, 'No course materials are available for your enrolled courses yet.');
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
    window.Auth.request('/student/reading-progress').then(function(result) {
      renderReadingProgress(result.readings || []);
    }).catch(function(error) {
      showEmpty(document.getElementById('readingProgressList'), 'Your reading plan could not be loaded: ' + error.message);
      var summary = document.getElementById('readingSummaryStats');
      summary.replaceChildren(node('div', 'overview-error', 'Reading progress is unavailable right now.'));
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
      var quizScores = quizHistory.map(function(result) { return Number(result.score); })
        .filter(function(score) { return Number.isFinite(score); });

      document.getElementById('overviewCourseCount').textContent = courses.length;
      document.getElementById('overviewAssignmentCount').textContent = pendingCount;
      document.getElementById('overviewQuizCount').textContent = quizzes.length;
      document.getElementById('overviewUnreadCount').textContent = unreadCount;
      document.getElementById('statQuizCount').textContent = quizHistory.length;
      document.getElementById('statAvgScore').textContent = quizScores.length
        ? Math.round(quizScores.reduce(function(total, score) { return total + score; }, 0) / quizScores.length) + '%'
        : '0%';
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
