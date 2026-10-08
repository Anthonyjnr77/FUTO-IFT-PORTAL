(function () {
  var storageKey = 'learnit-theme';
  var root = document.documentElement;
  var theme = 'light';

  try {
    var savedTheme = window.localStorage.getItem(storageKey);
    if (savedTheme === 'light' || savedTheme === 'dark') theme = savedTheme;
  } catch (error) {
    console.warn('LearnIT could not read the saved theme preference.', error);
  }

  function applyTheme(nextTheme, savePreference) {
    theme = nextTheme;
    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;

    if (savePreference) {
      try {
        window.localStorage.setItem(storageKey, theme);
      } catch (error) {
        console.warn('LearnIT could not save the theme preference.', error);
      }
    }

    var toggle = document.getElementById('learnit-theme-toggle');
    if (toggle) {
      var nextLabel = theme === 'dark' ? 'light' : 'dark';
      toggle.setAttribute('aria-label', 'Switch to ' + nextLabel + ' mode');
      toggle.setAttribute('title', 'Switch to ' + nextLabel + ' mode');
      toggle.setAttribute('aria-pressed', String(theme === 'dark'));
      toggle.innerHTML = theme === 'dark'
        ? '<span aria-hidden="true">&#9728;</span><span>Light mode</span>'
        : '<span aria-hidden="true">&#9790;</span><span>Dark mode</span>';
    }
  }

  applyTheme(theme, false);

  function setupMobileNavigation(navigation) {
    if (!navigation.classList.contains('navbar') || navigation.dataset.mobileNavReady === 'true') return;
    var navLinks = navigation.querySelector('.nav-links');
    if (!navLinks) return;

    var brand = navigation.querySelector('.learnit-brand');
    if (!brand) return;

    var menuId = 'learnit-mobile-nav-panel';
    var menuButton = document.createElement('button');
    menuButton.className = 'learnit-mobile-menu';
    menuButton.type = 'button';
    menuButton.textContent = '\u2630';
    menuButton.setAttribute('aria-label', 'Open navigation menu');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-controls', menuId);

    var panel = document.createElement('div');
    panel.className = 'mobile-nav-panel';
    panel.id = menuId;

    navigation.insertBefore(menuButton, brand.nextSibling);
    Array.from(navigation.childNodes).forEach(function (child) {
      if (child !== brand && child !== menuButton) panel.appendChild(child);
    });
    navigation.appendChild(panel);
    navigation.dataset.mobileNavReady = 'true';

    function closeMenu() {
      navigation.removeAttribute('data-mobile-menu-open');
      menuButton.textContent = '\u2630';
      menuButton.setAttribute('aria-label', 'Open navigation menu');
      menuButton.setAttribute('aria-expanded', 'false');
    }

    menuButton.addEventListener('click', function () {
      var isOpen = navigation.getAttribute('data-mobile-menu-open') === 'true';
      if (isOpen) {
        closeMenu();
        return;
      }
      navigation.setAttribute('data-mobile-menu-open', 'true');
      menuButton.textContent = '\u00d7';
      menuButton.setAttribute('aria-label', 'Close navigation menu');
      menuButton.setAttribute('aria-expanded', 'true');
    });

    panel.addEventListener('click', function (event) {
      if (event.target.closest('a')) closeMenu();
    });

    navigation.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && navigation.getAttribute('data-mobile-menu-open') === 'true') {
        closeMenu();
        menuButton.focus();
      }
    });
  }

  function addToggle() {
    var navigation = document.querySelector('.navbar, .topbar, body > header');
    if (navigation) {
      var navContent = navigation.querySelector('.nav-wrap') || navigation;
      var homeLink = navContent.querySelector('#homeLink');
      if (homeLink && !homeLink.querySelector('img')) {
        var homeLogo = document.createElement('img');
        homeLogo.src = '/assets/images/naits-futo-logo.jpg';
        homeLogo.alt = 'N.A.I.T.S. FUTO Chapter';
        homeLink.classList.add('learnit-brand');
        homeLink.setAttribute('aria-label', 'LearnIT home - Past questions');
        homeLink.insertBefore(homeLogo, homeLink.firstChild);
      } else if (!navContent.querySelector('.learnit-brand') && !navContent.querySelector('.brand')) {
        var lecturerNavigation = Boolean(navContent.querySelector('a[href*="lecturer-dashboard.html"]'));
        var brand = document.createElement('a');
        brand.className = 'learnit-brand';
        brand.href = lecturerNavigation ? 'lecturer-dashboard.html' : 'dashboard.html';
        brand.setAttribute('aria-label', 'LearnIT home');
        brand.innerHTML = '<img src="/assets/images/naits-futo-logo.jpg" alt="N.A.I.T.S. FUTO Chapter"><span>LearnIT</span>';
        navContent.insertBefore(brand, navContent.firstChild);
      }

      if (navContent === navigation) setupMobileNavigation(navigation);

      if (document.getElementById('learnit-theme-toggle')) {
        applyTheme(theme, false);
        return;
      }

      var toggle = document.createElement('button');
      toggle.id = 'learnit-theme-toggle';
      toggle.className = 'learnit-theme-toggle';
      toggle.type = 'button';
      toggle.addEventListener('click', function () {
        applyTheme(theme === 'dark' ? 'light' : 'dark', true);
      });

      var logout = navContent.querySelector('.nav-logout, .logout-btn, .nav-cta, .logout');
      if (logout) logout.parentNode.insertBefore(toggle, logout);
      else navContent.appendChild(toggle);
    } else {
      if (document.getElementById('learnit-theme-toggle')) {
        applyTheme(theme, false);
        return;
      }

      var toggle = document.createElement('button');
      toggle.id = 'learnit-theme-toggle';
      toggle.className = 'learnit-theme-toggle';
      toggle.type = 'button';
      toggle.addEventListener('click', function () {
        applyTheme(theme === 'dark' ? 'light' : 'dark', true);
      });
      document.body.appendChild(toggle);
    }

    applyTheme(theme, false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addToggle, { once: true });
  } else {
    addToggle();
  }
})();
