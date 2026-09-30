"use strict";

/* ── Insights ──────────────────────────────────────────────────────────── */

function renderInsights() {
  if (state.view !== "insights") {
    return;
  }

  const entries = state.data.products;
  renderSpendChart(entries);
  renderBudget(entries);
  renderInventory(entries);
  renderRatings(entries);
  renderBrands(entries);
  renderRepurchase(entries);
  renderValue(entries);
  renderDuelRanking(entries);
}

function renderSpendChart(entries) {
  const { buckets, undated, unpriced } = monthlySpend(entries, 12);
  const budget = state.data.settings.monthlyBudget;
  const max = Math.max(...buckets.map((bucket) => bucket.total), budget || 0, 1);
  const chart = clear(elements.spendChart);

  const notes = [];
  if (undated) notes.push(`${plural(undated, "entry", "entries")} without a purchase date`);
  if (unpriced) notes.push(`${unpriced} without a price`);
  elements.spendNote.textContent = `Last 12 months, dated purchases only.${notes.length ? ` Left out: ${notes.join(" and ")}.` : ""}`;

  const plot = h("div", { class: "month-plot", role: "img", "aria-label": "Monthly spend, last 12 months. The table below has the values." });
  if (typeof budget === "number" && budget > 0) {
    const line = h("span", { class: "budget-line", title: `Budget ${formatCurrency(budget)}` }, h("span", { class: "budget-line-label", text: `Budget ${formatCurrency(budget)}` }));
    line.style.bottom = `${(budget / max) * 100}%`;
    plot.appendChild(line);
  }

  for (const bucket of buckets) {
    const column = h("div", { class: "month-col", title: `${monthFormat.format(bucket.date)} ${bucket.date.getFullYear()}: ${formatCurrency(bucket.total)} across ${plural(bucket.count, "purchase")}` });
    const bar = h("span", { class: `month-bar${typeof budget === "number" && bucket.total > budget ? " is-over" : ""}` });
    bar.style.height = `${(bucket.total / max) * 100}%`;
    column.append(
      h("span", { class: "month-value", text: bucket.total ? `$${Math.round(bucket.total)}` : "" }),
      h("span", { class: "month-bar-wrap" }, bar)
    );
    plot.appendChild(column);
  }

  const labels = h("div", { class: "month-labels", "aria-hidden": "true" }, buckets.map((bucket) => h("span", { text: monthFormat.format(bucket.date) })));

  const table = h(
    "table",
    { class: "sr-only" },
    h("caption", { text: "Monthly spend" }),
    h("thead", null, h("tr", null, h("th", { scope: "col", text: "Month" }), h("th", { scope: "col", text: "Spend" }), h("th", { scope: "col", text: "Purchases" }))),
    h("tbody", null, buckets.map((bucket) => h("tr", null, h("td", { text: `${monthFormat.format(bucket.date)} ${bucket.date.getFullYear()}` }), h("td", { text: formatCurrency(bucket.total) }), h("td", { text: String(bucket.count) }))))
  );

  append(chart, [plot, labels, table]);
}

function renderBudget(entries) {
  const budget = state.data.settings.monthlyBudget;
  if (document.activeElement !== elements.budgetInput) {
    elements.budgetInput.value = budget ?? "";
  }

  const month = spendInMonth(entries);
  const shopping = state.data.wishlist.reduce((sum, item) => sum + (typeof item.price === "number" ? item.price : 0), 0);
  const summary = clear(elements.budgetSummary);

  if (typeof budget !== "number") {
    append(summary, [
      h("p", null, "This month so far: ", h("strong", { text: formatCurrency(month) })),
      shopping ? h("p", { class: "muted", text: `Your shopping list would add about ${formatCurrency(shopping)}.` }) : null,
    ]);
    return;
  }

  const meter = h("span", { class: `meter-fill${month > budget ? " is-over" : ""}` });
  meter.style.width = `${Math.min(100, budget ? (month / budget) * 100 : 100)}%`;
  append(summary, [
    h("p", null, h("strong", { text: formatCurrency(month) }), ` of ${formatCurrency(budget)} spent this month`),
    h("span", { class: "meter", role: "img", "aria-label": `${Math.round((month / (budget || 1)) * 100)}% of budget used` }, meter),
    h("p", { class: month > budget ? "is-over-text" : "muted", text: month > budget ? `${formatCurrency(month - budget)} over budget.` : `${formatCurrency(budget - month)} left.` }),
    shopping ? h("p", { class: "muted", text: `Shopping list estimate, not counted above: ${formatCurrency(shopping)}.` }) : null,
  ]);
}

function handleBudget(event) {
  event.preventDefault();
  const raw = elements.budgetInput.value.trim();
  const value = Core.toNumber(raw);
  if (raw && (value === null || value < 0)) {
    showToast("The budget must be a positive number, or blank for none.");
    return;
  }
  commit((data) => {
    data.settings = { ...data.settings, monthlyBudget: raw ? value : null };
  });
  showToast(raw ? `Monthly budget set to ${formatCurrency(value)}.` : "Monthly budget removed.");
}

function renderInventory(entries) {
  const container = clear(elements.inventorySummary);
  const counts = [
    ["unopened", "Unopened"],
    ["open", "In use"],
    ["finished", "Finished"],
    ["none", "Not tracked"],
  ].map(([key, label]) => [key, label, entries.filter((entry) => (entry.status || "none") === key).length]);
  const max = Math.max(...counts.map(([, , count]) => count), 1);

  for (const [key, label, count] of counts) {
    container.appendChild(
      barButton({
        label,
        value: count,
        max,
        title: `${label}: ${plural(count, "entry", "entries")}. Show these in the collection.`,
        onClick: count
          ? () => {
              prefs.filters = { ...defaultFilters(), statuses: [key] };
              savePrefs();
              syncFilterFields();
              showView("collection", { push: true });
            }
          : null,
      })
    );
  }
}

function renderRatings(entries) {
  const { buckets, unrated } = ratingDistribution(entries);
  const container = clear(elements.ratingChart);
  const max = Math.max(...buckets.map((bucket) => bucket.count), 1);
  const rated = entries.length - unrated;
  const average = rated ? entries.reduce((sum, entry) => sum + (entry.rating || 0), 0) / rated : null;
  elements.ratingsNote.textContent = rated
    ? `Average ${average.toFixed(1)} across ${plural(rated, "rated entry", "rated entries")}.${unrated ? ` ${unrated} not rated yet.` : ""}`
    : "Nothing rated yet.";

  for (const bucket of [...buckets].reverse()) {
    if (!bucket.count && bucket.score < 3) {
      continue;
    }
    container.appendChild(
      barButton({
        label: String(bucket.score),
        value: bucket.count,
        max,
        title: bucket.score === 10 ? `Rated 10: ${plural(bucket.count, "entry", "entries")}` : `Rated ${bucket.score} to ${bucket.score}.5: ${plural(bucket.count, "entry", "entries")}`,
      })
    );
  }
}

function renderBrands(entries) {
  const container = clear(elements.brandChart);
  const counts = countBy(entries.filter((entry) => entry.favorite), (entry) => entry.brand.trim());
  if (!counts.length) {
    container.appendChild(h("p", { class: "panel-empty", text: "Star a few entries that have a brand and they'll be counted here." }));
    return;
  }

  const max = counts[0][1];
  for (const [brand, count] of counts.slice(0, 8)) {
    container.appendChild(
      barButton({
        label: brand,
        value: count,
        max,
        title: `${brand}: ${plural(count, "favorite")}. Show them.`,
        onClick: () => {
          prefs.filters = { ...defaultFilters(), brands: [brand] };
          savePrefs();
          syncFilterFields();
          showView("favorites", { push: true });
        },
      })
    );
  }
}

/* Groups purchases of one product so "bought 3 times" is visible. */
function productGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.productKey || productLinkKey(entry.sourceUrl) || entry.id;
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function renderRepurchase(entries) {
  const container = clear(elements.repurchaseList);
  const groups = productGroups(entries)
    .map((group) => {
      const latest = sortEntries(group, "purchaseDate-desc")[0];
      const rated = group.filter((entry) => typeof entry.rating === "number");
      const prices = group.filter((entry) => typeof entry.price === "number");
      return {
        latest,
        count: group.length,
        explicit: group.some((entry) => entry.wouldRepurchase === true),
        rejected: latest.wouldRepurchase === false,
        liked: group.some(isLiked),
        rating: rated.length ? rated.reduce((sum, entry) => sum + entry.rating, 0) / rated.length : null,
        averagePrice: prices.length ? prices.reduce((sum, entry) => sum + entry.price, 0) / prices.length : null,
      };
    })
    .filter((group) => group.liked && !group.rejected)
    .sort((a, b) => Number(b.explicit) - Number(a.explicit) || (b.rating ?? -1) - (a.rating ?? -1) || b.count - a.count);

  if (!groups.length) {
    container.appendChild(h("p", { class: "panel-empty", text: "Nothing yet. Mark entries as favorites, rate them 8+, or answer “would you buy it again?”." }));
    return;
  }

  container.appendChild(
    h(
      "table",
      { class: "mini-table" },
      h("thead", null, h("tr", null, h("th", { scope: "col", text: "Product" }), h("th", { scope: "col", class: "num", text: "Rating" }), h("th", { scope: "col", class: "num", text: "Bought" }), h("th", { scope: "col", class: "num", text: "Avg paid" }), h("th", { scope: "col", text: "Last bought" }))),
      h(
        "tbody",
        null,
        groups.slice(0, 15).map((group) =>
          h(
            "tr",
            null,
            h("td", null, h("button", { type: "button", class: "name-link", onclick: () => openDetail(group.latest.id) }, group.latest.name), group.explicit ? h("span", { class: "sr-only", text: " (marked would buy again)" }) : null, group.explicit ? chip("Yes", "chip-accent chip-inline") : null),
            h("td", { class: "num", text: formatRating(group.rating) }),
            h("td", { class: "num", text: `${group.count}×` }),
            h("td", { class: "num private", text: formatCurrency(group.averagePrice) }),
            h("td", { text: formatDate(group.latest.purchaseDate) })
          )
        )
      )
    )
  );
}

function renderValue(entries) {
  const container = clear(elements.valueList);
  const withPrice = entries
    .map((entry) => ({ entry, price: unitPrice(entry) }))
    .filter(({ price }) => price && price.unit === "g");
  const leftOut = entries.length - withPrice.length;
  elements.valueNote.textContent = `Price paid divided by grams, grouped by type so unlike products are never ranked together.${leftOut ? ` ${plural(leftOut, "entry", "entries")} left out: no price, or an amount that doesn't read as grams.` : ""}`;

  if (!withPrice.length) {
    container.appendChild(h("p", { class: "panel-empty", text: "Record a price and an amount like 3.5g to compare value." }));
    return;
  }

  const byType = new Map();
  for (const row of withPrice) {
    const list = byType.get(row.entry.type) || [];
    list.push(row);
    byType.set(row.entry.type, list);
  }

  for (const [type, rows] of byType) {
    rows.sort((a, b) => a.price.value - b.price.value);
    container.appendChild(
      h(
        "section",
        { class: "value-group" },
        h("h3", { class: "detail-heading", text: typeLabel(type) }),
        h(
          "table",
          { class: "mini-table" },
          h("thead", null, h("tr", null, h("th", { scope: "col", text: "Product" }), h("th", { scope: "col", text: "Amount" }), h("th", { scope: "col", class: "num", text: "Paid" }), h("th", { scope: "col", class: "num", text: "Per gram" }))),
          h(
            "tbody",
            null,
            rows.map(({ entry }) =>
              h(
                "tr",
                null,
                h("td", null, h("button", { type: "button", class: "name-link", onclick: () => openDetail(entry.id) }, entry.name)),
                h("td", { text: entry.amount }),
                h("td", { class: "num", text: formatCurrency(entry.price) }),
                h("td", { class: "num", text: formatUnitPrice(entry) })
              )
            )
          )
        )
      )
    );
  }
}
