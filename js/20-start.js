"use strict";

/* Last: every file above has defined what these name. */

/* What the Research tab (js/3x-research-*.js) may use from the page. */
window.Cloudline = {
  addResearchPick,
  removeResearchPick,
  researchOwnership,
  showTerpene,
  closeTerpene,
  openEntry: (id) => openDetail(id),
  toast: (message) => showToast(message),
  get privacy() {
    return Boolean(prefs.privacy);
  },
};

initialize();
