"use strict";

/* ── Boot ──────────────────────────────────────────────────────────────── */

function initialize() {
  applyTheme();
  applyPrivacy();
  readUrl();

  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      showView(tab.dataset.view, { push: true });
    });
  });

  elements.searchInput.value = state.search;
  elements.searchInput.addEventListener("input", (event) => {
    state.search = event.target.value.trim();
    renderCollection();
    writeUrl({ replace: true });
  });

  elements.sortBy.value = prefs.sortBy;
  elements.sortBy.addEventListener("change", (event) => {
    prefs.sortBy = event.target.value;
    savePrefs();
    renderCollection();
  });

  elements.filterToggle.addEventListener("click", () => {
    const open = elements.filterPanel.hidden;
    elements.filterPanel.hidden = !open;
    elements.filterToggle.setAttribute("aria-expanded", String(open));
  });
  bindFilterFields();
  elements.saveViewButton.addEventListener("click", saveCurrentView);

  elements.addEntryButton.addEventListener("click", () => openEntryForm({ mode: "new" }));
  elements.ocsEntryButton.addEventListener("click", () => openEntryForm({ mode: "new", focusOcs: true }));

  elements.selectVisible.addEventListener("change", toggleSelectVisible);
  elements.bulkSelectAll.addEventListener("click", selectAllVisible);
  elements.bulkClear.addEventListener("click", () => {
    state.selected.clear();
    renderCollection();
  });
  elements.bulkCompare.addEventListener("click", () => openCompare([...state.selected]));
  elements.bulkEdit.addEventListener("click", openBulkEdit);
  elements.bulkExport.addEventListener("click", exportSelected);
  elements.bulkDelete.addEventListener("click", () => deleteEntries([...state.selected]));

  elements.form.addEventListener("submit", handleSubmit);
  elements.form.addEventListener("input", handleFormInput);
  elements.form.addEventListener("change", handleFormInput);
  fields.amount.addEventListener("blur", () => {
    fields.amount.value = normalizeAmount(fields.amount.value);
    updateAmountHint();
  });
  fields.type.addEventListener("change", suggestPotencyUnit);
  elements.form.querySelectorAll('input[name="potencyUnit"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      state.drawer.potencyTouched = true;
      applyPotencyUnit(radio.value);
      ["thc", "cbd"].forEach((name) => fields[name].getAttribute("aria-invalid") && validateField(name));
    });
  });
  elements.formOcsButton.addEventListener("click", fillFormFromOcs);
  elements.formOcsInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      fillFormFromOcs();
    }
  });
  elements.draftRestore.addEventListener("click", restoreDraft);
  elements.draftDiscard.addEventListener("click", () => {
    storageRemove(DRAFT_KEY);
    elements.draftNotice.hidden = true;
  });

  elements.drawerClose.addEventListener("click", requestCloseDrawer);
  elements.drawerCancel.addEventListener("click", cancelForm);
  elements.scrim.addEventListener("click", requestCloseDrawer);

  elements.linkForm.addEventListener("submit", (event) => {
    event.preventDefault();
    lookupForShopping(elements.linkInput.value.trim());
  });
  elements.linkRetry.addEventListener("click", () => lookupForShopping(state.lastLookupUrl, { skipDuplicateCheck: true }));
  elements.manualForm.addEventListener("submit", handleManualAdd);
  elements.wishSort.value = prefs.wishSort;
  elements.wishSort.addEventListener("change", (event) => {
    prefs.wishSort = event.target.value;
    savePrefs();
    renderWishlist();
  });

  elements.budgetForm.addEventListener("submit", handleBudget);

  elements.menuButton.addEventListener("click", toggleMenu);
  elements.exportButton.addEventListener("click", () => {
    closeMenu();
    exportData();
  });
  elements.importButton.addEventListener("click", () => {
    closeMenu();
    elements.importInput.click();
  });
  elements.importInput.addEventListener("change", importData);
  elements.backupsButton.addEventListener("click", () => {
    closeMenu();
    openBackups();
  });
  elements.trashButton.addEventListener("click", () => {
    closeMenu();
    openTrash();
  });
  elements.tagsButton.addEventListener("click", () => {
    closeMenu();
    openTagManager();
  });
  elements.themeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      prefs.theme = button.dataset.themeChoice;
      savePrefs();
      applyTheme();
    });
  });
  elements.remindersToggle.checked = prefs.reminders.enabled;
  elements.remindersToggle.addEventListener("change", () => {
    prefs.reminders.enabled = elements.remindersToggle.checked;
    savePrefs();
    renderReminder();
  });
  elements.resetButton.addEventListener("click", () => {
    closeMenu();
    confirmClearAll();
  });

  elements.privacyButton.addEventListener("click", () => {
    prefs.privacy = !prefs.privacy;
    savePrefs();
    applyPrivacy();
  });

  elements.reminderReview.addEventListener("click", reviewNextUnrated);
  elements.reminderSnooze.addEventListener("click", () => {
    prefs.reminders.snoozeUntil = today(new Date(Date.now() + 7 * 86400000));
    savePrefs();
    renderReminder();
    showToast("Rating reminders snoozed for a week.");
  });
  elements.reminderOff.addEventListener("click", () => {
    prefs.reminders.enabled = false;
    elements.remindersToggle.checked = false;
    savePrefs();
    renderReminder();
    showToast("Rating reminders are off. Turn them back on from the menu.");
  });

  elements.syncState.addEventListener("click", handleSyncClick);
  elements.bannerRetry.addEventListener("click", retryNow);
  elements.bannerExport.addEventListener("click", exportData);
  elements.toastAction.addEventListener("click", runToastAction);

  document.addEventListener("keydown", handleGlobalKeys);
  document.addEventListener("click", closeMenuOnOutsideClick);
  window.addEventListener("popstate", handlePopState);
  window.addEventListener("pagehide", saveDraft);
  window.addEventListener("online", retryNow);
  window.addEventListener("offline", () => {
    if (sync.available) {
      sync.status = "offline";
      renderSync();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      poll();
    }
  });

  showView(state.view, { push: false });
  setLinkStatus("");
  openFromUrl();

  hydrate();
  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      poll();
    }
  }, POLL_MS);

  registerServiceWorker();
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator && window.isSecureContext && sync.available) {
    navigator.serviceWorker.register("sw.js").catch((error) => console.warn("Offline support unavailable", error));
  }
}
