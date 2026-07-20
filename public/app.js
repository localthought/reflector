'use strict';

const el = (id) => document.getElementById(id);
const state = {
  configured: false,
  connected: false,
  calendars: [],
  activeCalendarId: null,
  events: [],
  editing: null, // { eventId } when editing, null when creating
  changeStates: {}, // changeId -> last seen state
  eventBadges: {}, // eventId -> 'syncing' | 'synced' | 'failed'
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error || message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  el('toasts').appendChild(node);
  setTimeout(() => node.remove(), 5000);
}

// --- Rendering -------------------------------------------------------------

function render() {
  el('connect-view').hidden = state.connected;
  el('app-view').hidden = !state.connected;
  el('download-btn').hidden = !state.connected;
  el('disconnect-btn').hidden = !state.connected;
  el('not-configured').hidden = state.configured;
  el('connect-btn').classList.toggle('disabled', !state.configured);
}

function eventWhen(event) {
  const start = event.start || {};
  const raw = start.dateTime || start.date;
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString();
}

function renderCalendars() {
  const list = el('calendar-list');
  list.innerHTML = '';
  for (const cal of state.calendars) {
    const li = document.createElement('li');
    if (cal.id === state.activeCalendarId) li.classList.add('active');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = cal.backgroundColor || '#6366f1';
    const label = document.createElement('span');
    label.textContent = cal.summary || cal.id;
    li.append(swatch, label);
    li.onclick = () => selectCalendar(cal.id);
    list.appendChild(li);
  }
}

function renderEvents() {
  el('events-title').textContent = state.activeCalendarId
    ? `Events — ${activeCalendarName()}`
    : 'Events';
  el('new-event-btn').disabled = !state.activeCalendarId;
  const list = el('event-list');
  list.innerHTML = '';
  if (!state.events.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = state.activeCalendarId ? 'No events.' : 'Select a calendar.';
    list.appendChild(li);
    return;
  }
  const sorted = [...state.events].sort(
    (a, b) => new Date(eventStartRaw(a)) - new Date(eventStartRaw(b)),
  );
  for (const event of sorted) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'event-title';
    title.textContent = event.summary || '(no title)';
    const when = document.createElement('div');
    when.className = 'event-when';
    when.textContent = eventWhen(event);
    info.append(title, when);
    li.appendChild(info);
    const badge = state.eventBadges[event.id];
    if (badge) {
      const b = document.createElement('span');
      b.className = `event-badge ${badge}`;
      b.textContent = badge === 'syncing' ? 'syncing…' : badge;
      li.appendChild(b);
    }
    li.onclick = () => openEditor(event);
    list.appendChild(li);
  }
}

function eventStartRaw(event) {
  const start = event.start || {};
  return start.dateTime || start.date || 0;
}

function activeCalendarName() {
  const cal = state.calendars.find((c) => c.id === state.activeCalendarId);
  return cal ? cal.summary || cal.id : '';
}

// --- Data flow -------------------------------------------------------------

async function loadMe() {
  const me = await api('/api/me');
  state.configured = me.configured;
  state.connected = me.connected;
  el('account').textContent = me.account?.email || '';
  render();
  if (state.connected) {
    await loadCalendars();
    startStatusPolling();
  }
}

async function loadCalendars() {
  const { calendars } = await api('/api/calendars');
  state.calendars = calendars;
  renderCalendars();
  if (!state.activeCalendarId && calendars.length) {
    await selectCalendar(calendars[0].id);
  }
}

async function selectCalendar(calendarId) {
  state.activeCalendarId = calendarId;
  renderCalendars();
  await loadEvents();
}

async function loadEvents() {
  if (!state.activeCalendarId) return;
  const { events } = await api(
    `/api/calendars/${encodeURIComponent(state.activeCalendarId)}/events`,
  );
  state.events = events;
  renderEvents();
}

async function fullRead() {
  const btn = el('read-btn');
  btn.disabled = true;
  el('read-summary').textContent = 'Reading everything from Google…';
  try {
    const summary = await api('/api/read', { method: 'POST' });
    el('read-summary').textContent = `Read ${summary.events} events across ${summary.calendars} calendars.`;
    await loadCalendars();
    await loadEvents();
    toast('Full read complete', 'success');
  } catch (err) {
    el('read-summary').textContent = '';
    toast(`Read failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// --- Editor ----------------------------------------------------------------

function toLocalInput(raw) {
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const off = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - off).toISOString().slice(0, 16);
}

function fromLocalInput(value) {
  return value ? new Date(value).toISOString() : '';
}

function openEditor(event) {
  const form = el('event-form');
  state.editing = event ? { eventId: event.id } : null;
  el('dialog-title').textContent = event ? 'Edit event' : 'New event';
  el('dialog-delete').hidden = !event;
  form.summary.value = event?.summary || '';
  form.location.value = event?.location || '';
  form.description.value = event?.description || '';
  form.start.value = toLocalInput(event ? eventStartRaw(event) : '');
  const endRaw = event ? event.end?.dateTime || event.end?.date : '';
  form.end.value = toLocalInput(endRaw);
  el('event-dialog').showModal();
}

async function saveEvent(e) {
  e.preventDefault();
  const form = el('event-form');
  const payload = {
    summary: form.summary.value.trim(),
    location: form.location.value.trim(),
    description: form.description.value.trim(),
    start: { dateTime: fromLocalInput(form.start.value) },
    end: { dateTime: fromLocalInput(form.end.value) },
  };
  const calendarId = encodeURIComponent(state.activeCalendarId);
  try {
    if (state.editing) {
      await api(`/api/calendars/${calendarId}/events/${encodeURIComponent(state.editing.eventId)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    } else {
      await api(`/api/calendars/${calendarId}/events`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    el('event-dialog').close();
    await loadEvents();
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error');
  }
}

async function deleteEvent() {
  if (!state.editing) return;
  const calendarId = encodeURIComponent(state.activeCalendarId);
  try {
    await api(`/api/calendars/${calendarId}/events/${encodeURIComponent(state.editing.eventId)}`, {
      method: 'DELETE',
    });
    el('event-dialog').close();
    await loadEvents();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, 'error');
  }
}

// --- Sync status polling ---------------------------------------------------

function setIndicator(cls, text) {
  const node = el('sync-indicator');
  node.className = `sync-indicator ${cls}`;
  node.textContent = text;
}

let statusTimer = null;
function startStatusPolling() {
  if (statusTimer) return;
  const tick = async () => {
    try {
      const status = await api('/api/status');
      await handleStatus(status);
    } catch {
      /* ignore transient errors */
    }
  };
  statusTimer = setInterval(tick, 1500);
  tick();
}

async function handleStatus(status) {
  const badges = {};
  let refreshNeeded = false;
  for (const change of status.changes) {
    // Keep the newest change per event for the badge.
    if (!badges[change.eventId]) {
      badges[change.eventId] = change.state;
    }
    const previous = state.changeStates[change.changeId];
    if (previous && previous !== change.state) {
      if (change.state === 'synced') {
        toast(`Synced: ${change.summary}`, 'success');
        refreshNeeded = true;
      } else if (change.state === 'failed') {
        toast(`Sync failed, change rolled back: ${change.summary} (${change.error || 'error'})`, 'error');
        refreshNeeded = true;
      }
    }
    state.changeStates[change.changeId] = change.state;
  }
  state.eventBadges = badges;

  if (status.syncing > 0) {
    setIndicator('syncing', `Syncing ${status.syncing} change${status.syncing > 1 ? 's' : ''}…`);
  } else if (status.failed > 0) {
    setIndicator('failed', `${status.failed} change${status.failed > 1 ? 's' : ''} failed`);
  } else {
    setIndicator('synced', 'All changes synced');
  }

  if (refreshNeeded) {
    await loadEvents();
  } else {
    renderEvents();
  }
}

// --- Wiring ----------------------------------------------------------------

el('read-btn').onclick = fullRead;
el('new-event-btn').onclick = () => openEditor(null);
el('event-form').onsubmit = saveEvent;
el('dialog-cancel').onclick = () => el('event-dialog').close();
el('dialog-delete').onclick = deleteEvent;
el('download-btn').onclick = () => {
  window.location.href = '/api/download/zip';
};
el('disconnect-btn').onclick = async () => {
  await api('/api/disconnect', { method: 'POST' });
  window.location.reload();
};

loadMe().catch((err) => toast(err.message, 'error'));
