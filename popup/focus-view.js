import {
  buildInsights,
  distractionTotal,
  emptyDay,
  formatDuration,
  lastDays,
  siteBreakdown,
  siteLabel,
} from '../lib/activity.js';
import { dateKey, formatDayLabel, parseDateKey } from '../lib/notes.js';
import { FOCUS_SNOOZE_MINUTES } from '../lib/constants.js';
import { h, setChildren, showToast } from './dom.js';

const openFocusSettings = () => chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#focus') });

function stat(value, label, tone = '') {
  return h('div', { className: `stat ${tone}` }, h('div', { className: 'stat-value' }, value), h('div', { className: 'stat-label' }, label));
}

function section(title, ...children) {
  return h('section', { className: 'focus-section' }, h('h3', {}, title), ...children);
}

function statusCard(status, refresh) {
  const { current, session, settings, snoozedUntil } = status;
  const onSite = current?.category === 'distraction' && current.counting;
  const threshold = settings.focusThresholdMinutes * 60_000;

  let headline;
  if (onSite && session) {
    const remaining = threshold - session.ms;
    headline = [
      h('strong', {}, `${siteLabel(current.site)}: ${formatDuration(session.ms)} this session`),
      h(
        'span',
        { className: 'muted' },
        remaining > 0 ? ` · reminder in ${formatDuration(remaining + 59_999)}` : ' · reminders are on'
      ),
    ];
  } else if (current?.category === 'review' && current.counting) {
    headline = [h('strong', { className: 'good' }, 'Reviewing on GitHub 👏')];
  } else if (session) {
    headline = [h('span', {}, `On a break from ${siteLabel(session.site)}. The session ends after 5 min away.`)];
  } else {
    headline = [h('span', { className: 'muted' }, 'Not on a distracting site right now.')];
  }

  const snoozeRow = snoozedUntil
    ? h(
        'div',
        { className: 'focus-row' },
        h('span', {}, `😴 Reminders snoozed until ${new Date(snoozedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`),
        h(
          'button',
          {
            className: 'link-btn',
            onClick: async () => {
              await chrome.runtime.sendMessage({ type: 'FOCUS_RESUME' });
              refresh();
            },
          },
          'Resume'
        )
      )
    : h(
        'div',
        { className: 'focus-row' },
        h('span', { className: 'muted' }, `Reminder after ${settings.focusThresholdMinutes} min, then every ${settings.focusRepeatMinutes} min.`),
        h(
          'button',
          {
            className: 'link-btn',
            onClick: async () => {
              await chrome.runtime.sendMessage({ type: 'FOCUS_SNOOZE', minutes: FOCUS_SNOOZE_MINUTES });
              showToast(`Reminders snoozed for ${FOCUS_SNOOZE_MINUTES} minutes`);
              refresh();
            },
          },
          `Snooze ${FOCUS_SNOOZE_MINUTES} min`
        )
      );

  return h(
    'div',
    { className: 'focus-status' },
    h('div', { className: 'focus-row' }, h('span', {}, headline)),
    snoozeRow,
    status.missingPermissions.length > 0 &&
      h(
        'div',
        { className: 'focus-row warning' },
        h('span', {}, `⚠ No access to ${status.missingPermissions.join(', ')}: time there isn't measured.`),
        h('button', { className: 'link-btn', onClick: openFocusSettings }, 'Fix')
      )
  );
}

function siteBars(day) {
  const sites = siteBreakdown(day);
  if (sites.length === 0) return h('p', { className: 'muted small' }, 'No time on distracting sites today. 🎯');
  const max = sites[0].ms;
  return h(
    'ul',
    { className: 'bars' },
    sites.map((s) =>
      h(
        'li',
        { className: 'bar-row' },
        h('span', { className: 'bar-label', title: s.site }, s.label),
        h('span', { className: 'bar-track' }, h('span', { className: 'bar-fill', style: { width: `${Math.max(4, (s.ms / max) * 100)}%` } })),
        h('span', { className: 'bar-value' }, formatDuration(s.ms))
      )
    )
  );
}

function weekChart(activity, today) {
  const days = lastDays(activity, today, 7);
  const max = Math.max(...days.map((d) => Math.max(d.distractionMs, d.reviewMs)), 1);
  const pct = (ms) => `${ms > 0 ? Math.max(3, (ms / max) * 100) : 0}%`;
  return h(
    'div',
    {},
    h(
      'div',
      { className: 'week-chart', role: 'img', 'aria-label': 'Distraction vs review time over the last 7 days' },
      days.map((d) =>
        h(
          'div',
          {
            className: `week-day${d.key === today ? ' today' : ''}`,
            title: `${formatDayLabel(d.key, today)}: ${formatDuration(d.distractionMs)} distracted, ${formatDuration(d.reviewMs)} on PRs, ${d.reviewsCleared} review(s) cleared`,
          },
          h(
            'div',
            { className: 'week-bars' },
            h('span', { className: 'week-bar distraction', style: { height: pct(d.distractionMs) } }),
            h('span', { className: 'week-bar review', style: { height: pct(d.reviewMs) } })
          ),
          h('span', { className: 'week-label' }, parseDateKey(d.key).toLocaleDateString(undefined, { weekday: 'narrow' }))
        )
      )
    ),
    h(
      'div',
      { className: 'legend' },
      h('span', {}, h('i', { className: 'dot distraction' }), 'Distracting sites'),
      h('span', {}, h('i', { className: 'dot review' }), 'GitHub PRs')
    )
  );
}

export function mountFocusView(container) {
  async function refresh() {
    let status;
    try {
      status = await chrome.runtime.sendMessage({ type: 'GET_FOCUS_STATUS' });
    } catch (error) {
      container.replaceChildren(h('p', { className: 'muted small' }, `Could not load focus data: ${error.message}`));
      return;
    }
    if (!status || status.success === false) {
      container.replaceChildren(h('p', { className: 'muted small' }, status?.error || 'Focus data unavailable.'));
      return;
    }

    const today = dateKey(new Date(status.now));
    const day = status.activity.days[today] || emptyDay();
    const hasHistory = Object.keys(status.activity.days).length > 0;

    if (!status.enabled) {
      setChildren(
        container,
        h(
          'div',
          { className: 'focus-intro' },
          h('div', { className: 'state-icon' }, '🎯'),
          h('p', { className: 'state-title' }, 'Focus monitor is off'),
          h(
            'p',
            { className: 'state-desc' },
            "Get a friendly nudge like \"Instead of more YouTube, there's a pending review. Finish it first, then enjoy the rest!\" when you've spent a while on distracting sites."
          ),
          h('p', { className: 'muted small' }, 'Opt-in. Only the sites you choose are measured, as daily totals stored on this device.'),
          h('button', { className: 'btn-primary', onClick: openFocusSettings }, 'Set up focus monitor')
        ),
        hasHistory && section('Last 7 days', weekChart(status.activity, today))
      );
      return;
    }

    const insights = buildInsights(status.activity, today);
    setChildren(
      container,
      statusCard(status, refresh),
      h(
        'div',
        { className: 'stats' },
        stat(formatDuration(distractionTotal(day)), 'distracting today', 'warn'),
        stat(formatDuration(day.reviewMs || 0), 'on GitHub PRs', 'good'),
        stat(String(day.reviewsCleared || 0), 'reviews cleared', 'good')
      ),
      section('Today by site', siteBars(day)),
      section('Last 7 days', weekChart(status.activity, today)),
      insights.length > 0 && section('Insights', h('ul', { className: 'insights' }, insights.map((text) => h('li', {}, text)))),
      h(
        'p',
        { className: 'focus-footer' },
        `Measuring ${status.settings.focusSites.length} site${status.settings.focusSites.length === 1 ? '' : 's'} · stored on this device · `,
        h('button', { className: 'link-btn', onClick: openFocusSettings }, 'Settings')
      )
    );
  }

  return { refresh };
}
