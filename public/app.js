document.addEventListener('DOMContentLoaded', () => {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  if (csrfToken) document.querySelectorAll('form[method="post"]').forEach((form) => {
    const tokenInput = document.createElement('input');
    tokenInput.type = 'hidden';
    tokenInput.name = '_csrf';
    tokenInput.value = csrfToken;
    form.append(tokenInput);
  });

  const dateLabel = document.querySelector('#today-label');
  if (dateLabel) dateLabel.textContent = new Intl.DateTimeFormat('da-DK', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  const passwordToggle = document.querySelector('.password-toggle');
  if (passwordToggle) passwordToggle.addEventListener('click', () => {
    const input = document.querySelector('#password');
    const showing = input.type === 'password';
    input.type = showing ? 'text' : 'password';
    passwordToggle.textContent = showing ? 'Skjul' : 'Vis';
    passwordToggle.setAttribute('aria-label', showing ? 'Skjul adgangskode' : 'Vis adgangskode');
  });

  const roleSelect = document.querySelector('#new-role');
  if (roleSelect) {
    roleSelect.replaceChildren(...[
      ['admin', 'Admin'],
      ['normal', 'Normal'],
      ['view', 'View'],
    ].map(([value, label]) => new Option(label, value)));
  }
  document.querySelectorAll('.role-pill').forEach((badge) => {
    const role = ['admin', 'normal', 'view'].find((value) => badge.classList.contains(value));
    if (role) badge.textContent = { admin: 'Admin', normal: 'Normal', view: 'View' }[role];
  });

  const modal = document.querySelector('[data-modal]');
  const openModal = document.querySelector('[data-open-modal]');
  const closeModal = document.querySelector('[data-close-modal]');
  if (modal && openModal && closeModal) {
    openModal.addEventListener('click', () => { modal.hidden = false; modal.querySelector('input:not([type="hidden"])')?.focus(); });
    closeModal.addEventListener('click', () => { modal.hidden = true; openModal.focus(); });
    modal.addEventListener('click', (event) => { if (event.target === modal) modal.hidden = true; });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modal.hidden) { modal.hidden = true; openModal.focus(); } });
  }

  const search = document.querySelector('[data-user-search]');
  if (search) search.addEventListener('input', () => {
    const query = search.value.trim().toLocaleLowerCase('da');
    let visible = 0;
    document.querySelectorAll('[data-user-row]').forEach((row) => {
      const matches = row.textContent.toLocaleLowerCase('da').includes(query);
      row.hidden = !matches;
      if (matches) visible += 1;
    });
    document.querySelector('.search-empty').hidden = visible !== 0;
  });

  const fileSearch = document.querySelector('[data-file-search]');
  if (fileSearch) fileSearch.addEventListener('input', () => {
    const query = fileSearch.value.trim().toLocaleLowerCase('da');
    let visible = 0;
    document.querySelectorAll('[data-file-row]').forEach((row) => {
      const matches = row.textContent.toLocaleLowerCase('da').includes(query);
      row.hidden = !matches;
      if (matches) visible += 1;
    });
    const emptyState = document.querySelector('.file-search-empty');
    if (emptyState) emptyState.hidden = visible !== 0;
  });

  // Generic list filtering. Rows carry data-f-<key> values; selects (data-filter-key) and button groups
  // (data-filter-buttons="<key>") filter on them. The search box matches every word against the row's
  // data-search text (or its visible text), so "køb aktiv" finds rows containing both words anywhere.
  const supportsHighlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
  document.querySelectorAll('[data-filter-scope]').forEach((scope, scopeIndex) => {
    const search = scope.querySelector('[data-filter-search]');
    const selects = [...scope.querySelectorAll('[data-filter-key]')];
    const buttonGroups = [...scope.querySelectorAll('[data-filter-buttons]')];
    const rows = [...scope.querySelectorAll('[data-filter-row]')].map((row) => {
      let fields = [];
      try { fields = JSON.parse(row.dataset.fields || '[]'); } catch { fields = []; }
      return { row, text: (row.dataset.search || row.textContent).toLocaleLowerCase('da'), fields, hint: row.querySelector('[data-match-hint]') };
    });
    const count = scope.querySelector('[data-filter-count]');
    const empty = scope.querySelector('[data-filter-empty]');
    const highlightName = 'filter-match-' + scopeIndex;
    const buttonValue = (group) => (group.querySelector('[aria-pressed="true"]') || {}).dataset?.value || '';
    const highlight = (terms) => {
      if (!supportsHighlights) return;
      CSS.highlights.delete(highlightName);
      if (!terms.length) return;
      const ranges = [];
      rows.forEach(({ row }) => {
        if (row.hidden) return;
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const value = node.nodeValue.toLocaleLowerCase('da');
          terms.forEach((term) => {
            for (let at = value.indexOf(term); at >= 0; at = value.indexOf(term, at + term.length)) {
              const range = new Range();
              range.setStart(node, at);
              range.setEnd(node, at + term.length);
              ranges.push(range);
            }
          });
        }
      });
      CSS.highlights.set(highlightName, new Highlight(...ranges));
    };
    const apply = () => {
      const terms = search ? search.value.trim().toLocaleLowerCase('da').split(/\s+/).filter(Boolean) : [];
      let visible = 0;
      rows.forEach(({ row, text, fields, hint }) => {
        const matchesSearch = terms.every((term) => text.includes(term));
        const matchesSelects = selects.every((select) => !select.value || row.getAttribute('data-f-' + select.dataset.filterKey) === select.value);
        const matchesButtons = buttonGroups.every((group) => !buttonValue(group) || row.getAttribute('data-f-' + group.dataset.filterButtons) === buttonValue(group));
        row.hidden = !(matchesSearch && matchesSelects && matchesButtons);
        if (!row.hidden) visible += 1;
        if (hint) {
          // Name the fields that matched, so a hit in a column that is not shown is still explained.
          const labels = terms.length && !row.hidden ? [...new Set(fields.filter(([, value]) => terms.some((term) => String(value).toLocaleLowerCase('da').includes(term))).map(([label]) => label))] : [];
          hint.textContent = labels.length ? 'Fundet i: ' + labels.join(', ') : '';
          hint.hidden = !labels.length;
        }
      });
      if (count) count.textContent = visible.toLocaleString('da-DK');
      if (empty) empty.hidden = visible !== 0;
      highlight(terms);
    };
    if (search) search.addEventListener('input', apply);
    selects.forEach((select) => select.addEventListener('change', apply));
    buttonGroups.forEach((group) => group.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (!button) return;
      group.querySelectorAll('button[data-value]').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
      apply();
    }));
    const reset = scope.querySelector('[data-filter-reset]');
    if (reset) reset.addEventListener('click', () => {
      if (search) search.value = '';
      selects.forEach((select) => { select.value = ''; });
      buttonGroups.forEach((group) => group.querySelectorAll('button[data-value]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.value === ''))));
      apply();
    });
    if ((search && search.value) || selects.some((select) => select.value) || buttonGroups.some((group) => buttonValue(group))) apply();
  });

  // Admin: "Redigér" on a user opens one shared modal filled with that user's name and e-mail.
  const editModal = document.querySelector('[data-edit-modal]');
  if (editModal) {
    const form = editModal.querySelector('[data-edit-form]');
    let opener = null;
    const close = () => { editModal.hidden = true; opener?.focus(); };
    document.querySelectorAll('[data-edit-user]').forEach((button) => button.addEventListener('click', () => {
      opener = button;
      form.action = button.dataset.action;
      form.elements.name.value = button.dataset.name;
      form.elements.email.value = button.dataset.email;
      editModal.hidden = false;
      form.elements.name.focus();
    }));
    editModal.querySelector('[data-close-edit-modal]').addEventListener('click', close);
    editModal.addEventListener('click', (event) => { if (event.target === editModal) close(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !editModal.hidden) close(); });
  }

  // Notification switches: keep the Til/Fra label in step with the checkbox.
  document.querySelectorAll('.notify-switch input').forEach((input) => input.addEventListener('change', () => {
    const state = input.parentElement.querySelector('.notify-state');
    if (state) state.textContent = input.checked ? 'Til' : 'Fra';
  }));

  const taskSearch = document.querySelector('[data-propbinder-search]');
  const taskStatusFilter = document.querySelector('[data-propbinder-status]');
  const taskPropertyFilter = document.querySelector('[data-propbinder-property]');
  if (taskSearch && taskStatusFilter) {
    const filterTaskRows = () => {
      const query = taskSearch.value.trim().toLocaleLowerCase('da');
      const status = taskStatusFilter.value;
      const property = taskPropertyFilter ? taskPropertyFilter.value : '';
      let visibleRows = 0;
      document.querySelectorAll('[data-propbinder-row]').forEach((row) => {
        const text = row.textContent.toLocaleLowerCase('da');
        const matchesSearch = !query || text.includes(query);
        const matchesStatus = !status || row.dataset.status === status;
        const matchesProperty = !property || row.dataset.property === property;
        row.hidden = !(matchesSearch && matchesStatus && matchesProperty);
        if (!row.hidden) visibleRows += 1;
      });
      const count = document.querySelector('[data-propbinder-count]');
      if (count) count.textContent = visibleRows.toLocaleString('da-DK');
      const empty = document.querySelector('[data-propbinder-empty]');
      if (empty) empty.hidden = visibleRows !== 0;
    };
    taskSearch.addEventListener('input', filterTaskRows);
    taskStatusFilter.addEventListener('change', filterTaskRows);
    if (taskPropertyFilter) taskPropertyFilter.addEventListener('change', filterTaskRows);
    if (taskSearch.value || (taskPropertyFilter && taskPropertyFilter.value)) filterTaskRows();
  }
});
