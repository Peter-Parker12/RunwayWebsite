// TIDE — shared interaction script

// Messages-to-the-Tide backend — same-origin API served by the Node
// backend alongside this static site (see backend/server.js).
const MESSAGES_API = '/api/messages';

document.addEventListener('DOMContentLoaded', () => {

  // Highlight current page in nav
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === path) a.classList.add('active');
  });

  // Nav background on scroll
  const nav = document.querySelector('.site-nav');
  const onScroll = () => {
    if (window.scrollY > 40) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  };
  window.addEventListener('scroll', onScroll);
  onScroll();

  // Mobile nav toggle
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle) {
    toggle.addEventListener('click', () => links.classList.toggle('open'));
  }
  // Mobile submenu toggle
  document.querySelectorAll('.has-sub > a').forEach(a => {
    a.addEventListener('click', (e) => {
      if (window.innerWidth <= 900) {
        e.preventDefault();
        a.parentElement.classList.toggle('open-sub');
      }
    });
  });

  // Scroll reveal
  const revealEls = document.querySelectorAll('.reveal');
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });
  revealEls.forEach(el => io.observe(el));

  // Archive filter pills (archive.html)
  const pills = document.querySelectorAll('.filter-pill');
  const items = document.querySelectorAll('[data-cat]');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const cat = pill.dataset.filter;
      items.forEach(item => {
        item.style.display = (cat === 'all' || item.dataset.cat === cat) ? '' : 'none';
      });
    });
  });

  // Guestbook form (messages.html) — reads/writes via the same-origin
  // /api/messages backend, so messages persist and are shared across
  // all visitors.
  const msgForm = document.getElementById('guestbook-form');
  const msgList = document.getElementById('guestbook-list');

  function renderMessage(entry, { prepend = false } = {}) {
    const card = document.createElement('div');
    card.className = 'msg-card reveal in';

    const nameEl = document.createElement('div');
    nameEl.className = 'msg-name';
    nameEl.textContent = entry.name;

    const textEl = document.createElement('p');
    textEl.className = 'msg-text';
    textEl.textContent = entry.message;

    card.append(nameEl, textEl);
    if (prepend) msgList.prepend(card);
    else msgList.append(card);
  }

  if (msgList) {
    msgList.innerHTML = '<p class="form-note">Loading messages…</p>';
    fetch(MESSAGES_API, { cache: 'no-store' })
      .then(res => res.ok ? res.json() : Promise.reject(new Error('Failed to load')))
      .then(entries => {
        msgList.innerHTML = '';
        if (!entries.length) {
          msgList.innerHTML = '<p class="form-note">No messages yet — be the first to leave one.</p>';
          return;
        }
        entries.forEach(entry => renderMessage(entry));
      })
      .catch(() => {
        msgList.innerHTML = '<p class="form-note">Couldn\'t load messages right now. Please try again later.</p>';
      });
  }

  if (msgForm) {
    msgForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('msg-name').value.trim();
      const message = document.getElementById('msg-text').value.trim();
      if (!name || !message) return;

      const submitBtn = msgForm.querySelector('button[type="submit"]');
      const originalLabel = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      try {
        const res = await fetch(MESSAGES_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, message }),
        });
        if (!res.ok) throw new Error('Request failed');
        const { entry } = await res.json();
        if (msgList) {
          const emptyNote = msgList.querySelector('.form-note');
          if (emptyNote) emptyNote.remove();
          renderMessage(entry, { prepend: true });
        }
        msgForm.reset();
      } catch (err) {
        alert('Sorry, your message could not be sent. Please try again.');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      }
    });
  }

  // RSVP form (invitation-box.html) — demo confirmation only
  const rsvpForm = document.getElementById('rsvp-form');
  if (rsvpForm) {
    rsvpForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const note = document.getElementById('rsvp-confirm');
      note.style.display = 'block';
      rsvpForm.reset();
    });
  }
});
