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

  // RSVP form (invitation-box.html) — name+email, then an attending/not
  // branch. Both branches reveal a panel with their own "Send RSVP" button:
  // attending asks for arrival time + transportation, not-attending offers
  // a note/voice/photo. Resubmitting with the same email updates the guest's
  // existing RSVP instead of creating a duplicate. Either path reveals a
  // shared post-submission gift panel (contribute or claim a wishlist item).
  const rsvpForm = document.getElementById('rsvp-form');
  if (rsvpForm) {
    let attending = null;
    const voiceApi = setUpVoiceRecorder();

    const panelAttending = document.getElementById('rsvp-panel-attending');
    const panelNotAttending = document.getElementById('rsvp-panel-not-attending');
    const choiceAttending = document.getElementById('choice-attending');
    const choiceNotAttending = document.getElementById('choice-not-attending');

    choiceAttending.addEventListener('click', () => {
      attending = true;
      choiceAttending.classList.add('active');
      choiceNotAttending.classList.remove('active');
      panelAttending.hidden = false;
      panelNotAttending.hidden = true;
      voiceApi.stopVoiceCleanup();
    });

    choiceNotAttending.addEventListener('click', () => {
      attending = false;
      choiceNotAttending.classList.add('active');
      choiceAttending.classList.remove('active');
      panelNotAttending.hidden = false;
      panelAttending.hidden = true;
    });

    document.getElementById('rsvp-send-attending').addEventListener('click', submitRsvp);
    document.getElementById('rsvp-send-note').addEventListener('click', submitRsvp);

    // Returning guest: pick up their token from a manage-RSVP email link
    // (?token=...) or from this browser's local storage, and jump straight
    // to their gift panel so they can claim/unclaim without resubmitting.
    const urlToken = new URLSearchParams(location.search).get('token');
    const savedToken = urlToken || localStorage.getItem('tide_rsvp_token');
    if (savedToken) {
      localStorage.setItem('tide_rsvp_token', savedToken);
      document.getElementById('rsvp-panel-gift').hidden = false;
      wireGiftPanel(savedToken);
    }

    async function submitRsvp() {
      const fullname = document.getElementById('rsvp-fullname').value.trim();
      const email = document.getElementById('rsvp-email').value.trim();
      if (!fullname || !email) {
        alert('Please enter your name and email.');
        return;
      }

      const fd = new FormData();
      fd.append('fullname', fullname);
      fd.append('email', email);
      fd.append('attending', String(attending));
      if (attending) {
        const arrival = document.getElementById('rsvp-time').value.trim();
        if (!arrival) {
          alert('Please enter your arrival time.');
          return;
        }
        fd.append('arrival', arrival);
        fd.append('transport', document.getElementById('rsvp-transport').value.trim());
      } else {
        fd.append('note', document.getElementById('rsvp-note').value.trim());
        const photoInput = document.getElementById('rsvp-photo');
        if (photoInput.files[0]) fd.append('photo', photoInput.files[0]);
        const voiceBlob = voiceApi.getVoiceBlob();
        if (voiceBlob) fd.append('voice', voiceBlob, `voice.${voiceBlob.type.includes('mp4') ? 'm4a' : 'webm'}`);
      }

      const trigger = document.getElementById(attending ? 'rsvp-send-attending' : 'rsvp-send-note');
      const originalLabel = trigger.textContent;
      trigger.disabled = true;
      trigger.textContent = 'Sending…';

      try {
        const res = await fetch('/api/rsvp', { method: 'POST', body: fd });
        if (!res.ok) throw new Error('Request failed');
        const data = await res.json();

        localStorage.setItem('tide_rsvp_token', data.token);
        document.getElementById('rsvp-confirm').textContent = data.updated
          ? 'Thank you — your RSVP has been updated.'
          : 'Thank you — your RSVP has been received.';
        document.getElementById('rsvp-confirm').style.display = 'block';
        document.getElementById('rsvp-panel-gift').hidden = false;
        wireGiftPanel(data.token);
        choiceAttending.disabled = true;
        choiceNotAttending.disabled = true;
        trigger.closest('.submit-row').style.display = 'none';
      } catch (err) {
        alert('Sorry, your RSVP could not be sent. Please try again.');
        trigger.disabled = false;
        trigger.textContent = originalLabel;
      }
    }
  }
});

// Wires the post-submission Contribute/Wishlist choice cards. Called both
// right after a successful RSVP submit and, for a returning guest, on page
// load — clones the buttons first so re-wiring never stacks up duplicate
// listeners.
function wireGiftPanel(token) {
  const contributeBtn = document.getElementById('choice-contribute');
  const wishlistBtn = document.getElementById('choice-wishlist');
  const freshContribute = contributeBtn.cloneNode(true);
  const freshWishlist = wishlistBtn.cloneNode(true);
  contributeBtn.replaceWith(freshContribute);
  wishlistBtn.replaceWith(freshWishlist);

  freshContribute.addEventListener('click', () => {
    document.getElementById('gift-panel-contribute').hidden = false;
    document.getElementById('gift-panel-wishlist').hidden = true;
  });
  freshWishlist.addEventListener('click', async () => {
    document.getElementById('gift-panel-wishlist').hidden = false;
    document.getElementById('gift-panel-contribute').hidden = true;
    await renderWishlist(token);
  });
}

// Small non-blocking message, used instead of alert() so claiming/unclaiming
// a gift never feels like it interrupted or reloaded the page.
function showToast(message) {
  let toast = document.getElementById('wishlist-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'wishlist-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove('visible'), 4500);
}

// Builds one wishlist row. Used both for the initial full render and to swap
// a single row in place after a successful claim/unclaim, without rebuilding
// (and flashing) the whole list.
function buildWishlistRow(item, token) {
  const row = document.createElement('div');
  const disabled = item.claimed && !item.claimedByYou;
  row.className = 'wishlist-item' + (disabled ? ' claimed' : '');
  const label = item.claimedByYou ? 'Unclaim' : (item.claimed ? 'Claimed' : 'Claim this gift');
  const tooltip = item.claimedByYou
    ? ' data-tooltip="You can also change your choice anytime via the link in your confirmation email."'
    : '';
  row.innerHTML = `<span class="name">${item.name}</span>` +
    `<button type="button" class="btn"${disabled ? ' disabled' : ''}${tooltip}>${label}</button>`;

  if (!disabled) {
    const btn = row.querySelector('button');
    const isUnclaim = item.claimedByYou;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await fetch(`/api/wishlist/${item.id}/${isUnclaim ? 'release' : 'claim'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.status === 409) {
        showToast('Sorry — someone just claimed this. Refreshing the list…');
        await renderWishlist(token);
      } else if (res.ok) {
        showToast(isUnclaim
          ? "You've released this gift."
          : "Claimed! A confirmation email is on its way — you can change your choice via the link inside it.");
        row.replaceWith(buildWishlistRow({ ...item, claimed: !isUnclaim, claimedByYou: !isUnclaim }, token));
      } else {
        showToast('Something went wrong. Please try again.');
        btn.disabled = false;
      }
    });
  }
  return row;
}

async function renderWishlist(token) {
  const list = document.getElementById('wishlist-list');
  list.innerHTML = 'Loading…';
  const items = await (await fetch(`/api/wishlist?token=${encodeURIComponent(token)}`)).json();
  list.innerHTML = '';
  items.forEach(item => list.appendChild(buildWishlistRow(item, token)));
}

// Wires the 30-second voice recorder in the "I can't make it" panel.
// Returns { getVoiceBlob, stopVoiceCleanup } used by the RSVP submit handler.
function setUpVoiceRecorder() {
  const recordBtn = document.getElementById('voice-record-btn');
  const rerecordBtn = document.getElementById('voice-rerecord-btn');
  const timerEl = document.getElementById('voice-timer');
  const previewEl = document.getElementById('voice-preview');
  if (!recordBtn) return { getVoiceBlob: () => null, stopVoiceCleanup: () => {} };

  let mediaStream = null, mediaRecorder = null, chunks = [], recordedBlob = null, countdownTimer = null;

  const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus'];
  const pickMime = () => MIME_CANDIDATES.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      alert('Voice recording is not supported on this device/browser.');
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      alert('Microphone permission was denied.');
      return;
    }

    chunks = [];
    const mimeType = pickMime();
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      recordedBlob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      previewEl.src = URL.createObjectURL(recordedBlob);
      previewEl.hidden = false;
      rerecordBtn.hidden = false;
      mediaStream.getTracks().forEach(t => t.stop());
      mediaStream = null;
    };
    mediaRecorder.start();
    recordBtn.textContent = 'Stop Recording';
    timerEl.hidden = false;
    runCountdown(30);
  }

  function runCountdown(total) {
    let remaining = total;
    timerEl.textContent = `00:00 / 00:${String(total).padStart(2, '0')}`;
    countdownTimer = setInterval(() => {
      remaining -= 1;
      const elapsed = total - remaining;
      timerEl.textContent = `00:${String(elapsed).padStart(2, '0')} / 00:${String(total).padStart(2, '0')}`;
      if (remaining <= 0) stop();
    }, 1000);
  }

  function stop() {
    clearInterval(countdownTimer);
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    recordBtn.textContent = 'Start Recording';
    timerEl.hidden = true;
  }

  recordBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') stop(); else start();
  });
  rerecordBtn.addEventListener('click', () => {
    recordedBlob = null;
    previewEl.hidden = true;
    rerecordBtn.hidden = true;
    start();
  });
  window.addEventListener('beforeunload', () => mediaStream?.getTracks().forEach(t => t.stop()));

  return {
    getVoiceBlob: () => recordedBlob,
    stopVoiceCleanup: () => {
      clearInterval(countdownTimer);
      mediaStream?.getTracks().forEach(t => t.stop());
      mediaStream = null;
    },
  };
}
