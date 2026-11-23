/** SF Symbols–style line icons (inline SVG, inherit currentColor). */
const svg = (body: string, size = 20, fill = 'none') =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  radar: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>'),
  moon: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M20.4 14.6A8.5 8.5 0 0 1 9.4 3.6a8.5 8.5 0 1 0 11 11z"/></svg>`,
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', 17, 'none'),
  sliders: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>', 17),
  location: svg('<path d="M3 11l18-8-8 18-2-8z"/>', 18),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 14),
  person: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', 18),
  layers: svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>', 18),
  globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>', 18),
  plane: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 1.5c.9 0 1.5 1.1 1.5 2.4v5.3l8 4.6v2.1l-8-2.4v4.7l2.4 1.8v1.7L12 20.6l-3.9 1.1V20l2.4-1.8v-4.7l-8 2.4v-2.1l8-4.6V3.9c0-1.3.6-2.4 1.5-2.4z"/></svg>`,
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 17),
  calendar: svg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>', 17),
  chevron: svg('<path d="M9 6l6 6-6 6"/>', 14),
  back: svg('<path d="M15 5l-7 7 7 7"/>', 22),
  gauge: svg('<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 13l4-4"/><circle cx="12" cy="13" r="1.3" fill="currentColor"/>', 18),
  bolt: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M13.5 2 4 13.5h7L10 22l9.5-11.5h-7z"/></svg>`,
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 18),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>', 18),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 20),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', 17),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>', 17),
  external: svg('<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>', 16),
  arrowRight: svg('<path d="M5 12h14M13 6l6 6-6 6"/>', 18),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>', 17),
  download: svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', 15),
  sidebar: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>', 18),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 17),
  warn: svg('<path d="M12 3 2 20h20zM12 10v4"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/>', 17),
};
