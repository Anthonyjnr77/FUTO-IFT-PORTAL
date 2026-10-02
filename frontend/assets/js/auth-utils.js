window.Auth = {

  apiBase: window.FUTO_API_BASE || (
    ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.protocol !== 'file:')
      ? 'http://localhost:3000/api'
      : 'https://futo-ift-portal.onrender.com/api'
  ),

  request: async function(path, options) {
    var config = options || {};
    config.headers = Object.assign({ 'Content-Type': 'application/json' }, config.headers || {});
    var token = localStorage.getItem('futo_token') || sessionStorage.getItem('futo_token');
    if (token) config.headers.Authorization = 'Bearer ' + token;
    var response = await fetch(this.apiBase + path, config);
    var body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Request failed.');
    return body;
  },

  set: function(user) {
    var data = {
      matric:    user.matric    || '',
      name:      user.name      || 'Student',
      role:      user.role      || 'student',
      dept:      user.dept      || 'IFT',
      level:     user.level     || '',
      isLoggedIn: true,
      loginTime: new Date().toISOString()
    };
    localStorage.removeItem('futo_lecturer');
    sessionStorage.removeItem('futo_lecturer');
    localStorage.removeItem('futo_admin');
    sessionStorage.removeItem('futo_admin');
    sessionStorage.removeItem('futo_token');
    if (user.token) localStorage.setItem('futo_token', user.token);
    localStorage.setItem('futo_session', JSON.stringify(data));
  },

  get: function() {
    var s = localStorage.getItem('futo_session');
    if (!s) return null;
    try { return JSON.parse(s); } catch(e) { return null; }
  },

  setLecturer: function(user) {
    var data = {
      user:      user.user      || 'lecturer',
      name:      user.name      || 'Lecturer',
      role:      'lecturer',
      isLoggedIn: true,
      loginTime: new Date().toISOString()
    };
    localStorage.removeItem('futo_session');
    localStorage.removeItem('futo_lecturer');
    localStorage.removeItem('futo_token');
    localStorage.removeItem('futo_admin');
    sessionStorage.removeItem('futo_lecturer');
    sessionStorage.removeItem('futo_token');
    sessionStorage.removeItem('futo_admin');
    var storage = user.rememberMe ? localStorage : sessionStorage;
    if (user.token) storage.setItem('futo_token', user.token);
    storage.setItem('futo_lecturer', JSON.stringify(data));
  },

  getLecturer: function() {
    var s = sessionStorage.getItem('futo_lecturer') || localStorage.getItem('futo_lecturer');
    if (!s) return null;
    try { return JSON.parse(s); } catch(e) { return null; }
  },

  setAdmin: function(user) {
    var data = {
      id: user.id || '',
      identifier: user.identifier || '',
      name: user.name || 'Administrator',
      role: 'admin',
      isLoggedIn: true,
      loginTime: new Date().toISOString()
    };
    localStorage.removeItem('futo_session');
    localStorage.removeItem('futo_lecturer');
    localStorage.removeItem('futo_admin');
    localStorage.removeItem('futo_token');
    sessionStorage.removeItem('futo_session');
    sessionStorage.removeItem('futo_lecturer');
    sessionStorage.removeItem('futo_admin');
    sessionStorage.removeItem('futo_token');
    if (user.token) sessionStorage.setItem('futo_token', user.token);
    sessionStorage.setItem('futo_admin', JSON.stringify(data));
  },

  getAdmin: function() {
    var s = sessionStorage.getItem('futo_admin');
    if (!s) return null;
    try { return JSON.parse(s); } catch(e) { return null; }
  },

  protect: function() {
    var user = this.get();
    if (user && user.isLoggedIn) return user;

    var lecturer = this.getLecturer();
    if (lecturer && lecturer.isLoggedIn) return lecturer;

    window.location.href = 'index.html';
    return null;
  },

  protectLecturer: function() {
    var student = this.get();
    if (student && student.isLoggedIn) {
      window.location.href = 'dashboard.html';
      return null;
    }
    var lecturer = this.getLecturer();
    if (!lecturer || !lecturer.isLoggedIn || lecturer.role !== 'lecturer') {
      window.location.href = 'lecturer-login.html';
      return null;
    }
    return lecturer;
  },

  protectAdmin: function() {
    var admin = this.getAdmin();
    if (admin && admin.isLoggedIn && admin.role === 'admin') return admin;
    var student = this.get();
    var lecturer = this.getLecturer();
    window.location.href = student && student.isLoggedIn
      ? 'dashboard.html'
      : lecturer && lecturer.isLoggedIn ? 'lecturer-dashboard.html' : 'admin-login.html';
    return null;
  },

  logout: function() {
    var self = this;
    var clearSession = function() {
      localStorage.removeItem('futo_session');
      localStorage.removeItem('futo_lecturer');
      localStorage.removeItem('futo_admin');
      localStorage.removeItem('futo_token');
      sessionStorage.removeItem('futo_session');
      sessionStorage.removeItem('futo_lecturer');
      sessionStorage.removeItem('futo_admin');
      sessionStorage.removeItem('futo_token');
      window.location.href = 'index.html';
    };
    if (!localStorage.getItem('futo_token') && !sessionStorage.getItem('futo_token')) {
      clearSession();
      return;
    }
    self.request('/auth/logout', { method: 'POST' }).catch(function() {}).finally(clearSession);
  },

  saveQuiz: function(courseCode, score) {
    var key = 'futo_quiz_results';
    var existing = localStorage.getItem(key);
    var results = [];
    if (existing) {
      try { results = JSON.parse(existing); } catch(e) { results = []; }
    }
    var session = this.get() || {};
    results.unshift({
      courseCode: courseCode,
      score:      score,
      date:       new Date().toISOString(),
      matric:     session.matric || '',
      name:       session.name   || ''
    });
    /* Keep only last 20 results */
    results = results.slice(0, 20);
    localStorage.setItem(key, JSON.stringify(results));
  },

  getQuizResults: function() {
    var key = 'futo_quiz_results';
    var existing = localStorage.getItem(key);
    if (!existing) return [];
    try { return JSON.parse(existing); } catch(e) { return []; }
  },

  getRecentQuizResults: function(limit) {
    return this.getQuizResults().slice(0, limit || 3);
  },

  /* Leaderboard: return top N scores across all students */
  getLeaderboard: function(limit) {
    var all = this.getQuizResults();
    if (!all || !all.length) return [];
    // keep highest score per student per course, then sort
    var map = {};
    all.forEach(function(r) {
      var key = (r.matric || 'anon') + '|' + (r.courseCode || '');
      if (!map[key] || map[key].score < r.score) map[key] = r;
    });
    var arr = Object.keys(map).map(function(k){ return map[k]; });
    arr.sort(function(a,b){ return b.score - a.score; });
    return arr.slice(0, limit || 10);
  },

  clearQuizResults: function() {
    localStorage.removeItem('futo_quiz_results');
  },

  updateNav: function() {
    var session = this.get();
    var name = document.getElementById('navName');
    var matric = document.getElementById('navMatric');
    var firstName = session && session.name ? session.name.trim().split(/\s+/)[0] : 'Student';
    if (name) name.textContent = firstName;
    if (matric) matric.textContent = session && session.matric ? session.matric : '---';
  }

};

window.Auth.updateNav();