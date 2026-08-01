// TIDE — shared interaction script

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

  // RSVP form (invitation-box.html) — submits to the backend, which
  // saves the RSVP and emails the designated mailbox.
  const rsvpForm = document.getElementById('rsvp-form');
  if (rsvpForm) {
    rsvpForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const channels = Array.from(rsvpForm.querySelectorAll('input[name="channel"]:checked')).map(c => c.value);
      const payload = {
        fullname: document.getElementById('rsvp-fullname').value.trim(),
        arrival: document.getElementById('rsvp-time').value.trim(),
        allergy: document.getElementById('rsvp-allergy').value.trim(),
        transport: document.getElementById('rsvp-transport').value.trim(),
        email: document.getElementById('rsvp-email').value.trim(),
        channels,
      };

      const submitBtn = rsvpForm.querySelector('button[type="submit"]');
      const originalLabel = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      const note = document.getElementById('rsvp-confirm');
      note.style.display = 'none';

      try {
        const res = await fetch('/api/rsvp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('Request failed');
        note.style.display = 'block';
        rsvpForm.reset();
      } catch (err) {
        alert('Sorry, your RSVP could not be sent. Please try again.');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      }
    });
  }
});
