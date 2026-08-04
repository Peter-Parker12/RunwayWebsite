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

  // RSVP form (invitation-box.html) — name+email, an attending/not toggle,
  // an always-visible "send a few words / voice / photo" section, then a
  // gift chooser (Contribute or Wishlist) *above* the single Send RSVP
  // button — the guest picks a gift before submitting; the server attempts
  // to claim it atomically as part of the same request. On success (or once
  // returning later via a manage-RSVP link), the form collapses down to
  // just the gift panel so managing a claim never requires refilling RSVP
  // details.
  const rsvpForm = document.getElementById('rsvp-form');
  if (rsvpForm) {
    let attending = null;
    let selectedGiftChoice = ''; // 'contribute' | 'wishlist' | ''
    let selectedWishlistItemId = null;
    const voiceApi = setUpVoiceRecorder();

    const identityFields = document.getElementById('rsvp-identity-fields');
    const attendingToggle = document.getElementById('rsvp-attending-toggle');
    const panelAttending = document.getElementById('rsvp-panel-attending');
    const panelNotAttending = document.getElementById('rsvp-panel-not-attending');
    const messageSection = document.getElementById('rsvp-message-section');
    const submitRow = document.getElementById('rsvp-submit-row');
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

    // Pre-submit gift chooser — selection only, no API calls yet. The same
    // #choice-contribute/#choice-wishlist buttons get re-wired into
    // claim/unclaim mode by wireGiftPanel() once a token exists (see
    // collapseToGiftPanel below), so these listeners are only ever active
    // before the RSVP has been submitted.
    const choiceContribute = document.getElementById('choice-contribute');
    const choiceWishlist = document.getElementById('choice-wishlist');
    const giftPanelContribute = document.getElementById('gift-panel-contribute');
    const giftPanelWishlist = document.getElementById('gift-panel-wishlist');

    choiceContribute.addEventListener('click', () => {
      selectedGiftChoice = selectedGiftChoice === 'contribute' ? '' : 'contribute';
      selectedWishlistItemId = null;
      choiceContribute.classList.toggle('active', selectedGiftChoice === 'contribute');
      choiceWishlist.classList.remove('active');
      giftPanelContribute.hidden = selectedGiftChoice !== 'contribute';
      giftPanelWishlist.hidden = true;
    });

    choiceWishlist.addEventListener('click', async () => {
      const nowSelected = selectedGiftChoice !== 'wishlist';
      selectedGiftChoice = nowSelected ? 'wishlist' : '';
      choiceWishlist.classList.toggle('active', nowSelected);
      choiceContribute.classList.remove('active');
      giftPanelContribute.hidden = true;
      giftPanelWishlist.hidden = !nowSelected;
      if (nowSelected) await renderWishlistSelect();
    });

    async function renderWishlistSelect() {
      const list = document.getElementById('wishlist-list');
      list.innerHTML = 'Loading…';
      const items = await (await fetch('/api/wishlist')).json();
      list.innerHTML = '';
      items.forEach(item => {
        const row = document.createElement('div');
        const isSelected = selectedWishlistItemId === item.id;
        row.className = 'wishlist-item' + (item.claimed ? ' claimed' : '') + (isSelected ? ' selected' : '');
        const label = item.claimed ? 'Taken' : (isSelected ? 'Selected' : 'Select this gift');
        row.innerHTML = `<span class="name">${item.name}</span>` +
          `<button type="button" class="btn"${item.claimed ? ' disabled' : ''}>${label}</button>`;
        if (!item.claimed) {
          row.querySelector('button').addEventListener('click', () => {
            selectedWishlistItemId = isSelected ? null : item.id;
            renderWishlistSelect();
          });
        }
        list.appendChild(row);
      });
    }

    // Collapses the form down to just the gift panel — used right after a
    // successful submit, and for a returning guest who never needs to fill
    // out the form again just to manage their gift.
    function collapseToGiftPanel(token) {
      identityFields.hidden = true;
      attendingToggle.hidden = true;
      panelAttending.hidden = true;
      panelNotAttending.hidden = true;
      messageSection.hidden = true;
      submitRow.hidden = true;
      wireGiftPanel(token);
      document.getElementById('gift-panel-contribute').hidden = true;
      document.getElementById('gift-panel-wishlist').hidden = true;
      document.getElementById('choice-contribute').classList.remove('active');
      document.getElementById('choice-wishlist').classList.remove('active');
    }

    rsvpForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fullname = document.getElementById('rsvp-fullname').value.trim();
      const email = document.getElementById('rsvp-email').value.trim();
      if (!fullname || !email) {
        alert('Please enter your name and email.');
        return;
      }
      if (attending === null) {
        alert('Please let us know if you can attend.');
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
        rsvpForm.querySelectorAll('input[name="channel"]:checked').forEach(c => fd.append('channels', c.value));
      }

      fd.append('note', document.getElementById('rsvp-note').value.trim());
      const photoInput = document.getElementById('rsvp-photo');
      if (photoInput.files[0]) fd.append('photo', photoInput.files[0]);
      const voiceBlob = voiceApi.getVoiceBlob();
      if (voiceBlob) fd.append('voice', voiceBlob, `voice.${voiceBlob.type.includes('mp4') ? 'm4a' : 'webm'}`);

      if (selectedGiftChoice === 'contribute') {
        fd.append('giftChoice', 'contribute');
      } else if (selectedGiftChoice === 'wishlist' && selectedWishlistItemId) {
        fd.append('giftChoice', 'wishlist');
        fd.append('wishlistItemId', String(selectedWishlistItemId));
      }

      const submitBtn = document.getElementById('rsvp-submit');
      const originalLabel = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      try {
        const res = await fetch('/api/rsvp', { method: 'POST', body: fd });
        if (!res.ok) throw new Error('Request failed');
        const data = await res.json();

        localStorage.setItem('tide_rsvp_token', data.token);
        document.getElementById('rsvp-confirm').textContent = data.updated
          ? 'Thank you — your RSVP has been updated.'
          : 'Thank you — your RSVP has been received.';
        document.getElementById('rsvp-confirm').style.display = 'block';

        if (data.giftConflict) {
          showToast('Sorry — that gift was just claimed by someone else. Pick another below.');
        }

        collapseToGiftPanel(data.token);
      } catch (err) {
        alert('Sorry, your RSVP could not be sent. Please try again.');
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      }
    });

    // Returning guest: pick up their token from a manage-RSVP email link
    // (?token=...) or from this browser's local storage, and skip straight
    // to the gift panel — no need to fill out the RSVP again.
    const urlToken = new URLSearchParams(location.search).get('token');
    const savedToken = urlToken || localStorage.getItem('tide_rsvp_token');
    if (savedToken) {
      localStorage.setItem('tide_rsvp_token', savedToken);
      document.getElementById('rsvp-confirm').style.display = 'none';
      collapseToGiftPanel(savedToken);
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
  if (item.claimedByYou) {
    row.setAttribute('data-tooltip', 'You can also change your choice anytime via the link in your confirmation email.');
  }
  const label = item.claimedByYou ? 'Unclaim' : (item.claimed ? 'Claimed' : 'Claim this gift');
  row.innerHTML = `<span class="name">${item.name}</span>` +
    `<button type="button" class="btn"${disabled ? ' disabled' : ''}>${label}</button>`;

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
