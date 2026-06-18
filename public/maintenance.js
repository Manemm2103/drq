const storageKey = 'icq_user';
const appState = {
    currentUser: null,
    summary: {},
    buildings: [],
    apartments: [],
    templates: [],
    assets: [],
    staff: [],
    plans: [],
    planCompletions: [],
    openedPlanId: null,
    completionChecklistState: [],
    completionPhotoFiles: [],
    signaturePad: null,
    filters: {
        dashboard: '',
        buildings: '',
        apartments: '',
        templates: '',
        assets: '',
        staff: '',
        calendar: '',
        plans: ''
    },
    calendarView: 'month',
    calendarDate: new Date(),
    selectedDate: new Date().toISOString().slice(0, 10)
};

document.addEventListener('DOMContentLoaded', async () => {
    bindNavigation();
    bindForms();
    await bootstrapBoard();
});

function bindNavigation() {
    document.querySelectorAll('.nav-btn').forEach((button) => {
        button.addEventListener('click', () => setActiveTab(button.dataset.tab || 'dashboard'));
    });
    document.querySelectorAll('.segment-btn').forEach((button) => {
        button.addEventListener('click', () => setCalendarView(button.dataset.calendarView || 'month'));
    });
    document.getElementById('calendar-year-select').addEventListener('change', handleCalendarJumpChange);
    document.getElementById('calendar-month-select').addEventListener('change', handleCalendarJumpChange);
    document.getElementById('calendar-prev-btn').addEventListener('click', () => shiftCalendarRange(-1));
    document.getElementById('calendar-next-btn').addEventListener('click', () => shiftCalendarRange(1));
    document.getElementById('calendar-today-btn').addEventListener('click', goToCalendarToday);
    bindTableSearch('dashboard-plan-search', 'dashboard');
    bindTableSearch('building-search', 'buildings');
    bindTableSearch('apartment-search', 'apartments');
    bindTableSearch('template-search', 'templates');
    bindTableSearch('asset-search', 'assets');
    bindTableSearch('staff-search', 'staff');
    bindTableSearch('calendar-search', 'calendar');
    bindTableSearch('plan-search', 'plans');
}

function setActiveTab(tabName) {
    document.querySelectorAll('.nav-btn').forEach((button) => {
        button.classList.toggle('active', button.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.panel === tabName);
    });
    const titleMap = {
        dashboard: 'Dashboard',
        buildings: 'Gebäude',
        apartments: 'Apartments',
        templates: 'Stammdaten',
        assets: 'Wartungsobjekte',
        staff: 'Mitarbeiter',
        calendar: 'Kalender',
        plans: 'Wartungspläne'
    };
    document.getElementById('tab-title').textContent = titleMap[tabName] || 'Dashboard';
}

function bindForms() {
    document.getElementById('building-form').addEventListener('submit', submitBuildingForm);
    document.getElementById('apartment-form').addEventListener('submit', submitApartmentForm);
    document.getElementById('template-form').addEventListener('submit', submitTemplateForm);
    document.getElementById('asset-form').addEventListener('submit', submitAssetForm);
    document.getElementById('staff-form').addEventListener('submit', submitStaffForm);
    document.getElementById('plan-form').addEventListener('submit', submitPlanForm);
    document.getElementById('calendar-quick-form').addEventListener('submit', submitCalendarQuickForm);
    document.getElementById('asset-building').addEventListener('change', syncApartmentOptions);
    document.getElementById('asset-template').addEventListener('change', hydrateAssetFromTemplate);
    document.getElementById('plan-asset').addEventListener('change', hydratePlanFromAsset);
    document.getElementById('calendar-plan-asset').addEventListener('change', hydrateCalendarTitleFromAsset);
    document.getElementById('plan-completion-photos').addEventListener('change', handleCompletionPhotoSelection);
    initializeSignaturePad();
}

async function bootstrapBoard() {
    const saved = localStorage.getItem(storageKey);
    if (!saved) {
        window.location.href = '/';
        return;
    }

    try {
        appState.currentUser = JSON.parse(saved);
    } catch (error) {
        localStorage.removeItem(storageKey);
        window.location.href = '/';
        return;
    }

    try {
        const result = await api(`/api/maintenance/bootstrap?requesterId=${encodeURIComponent(appState.currentUser.id)}`);
        appState.summary = result.summary || {};
        appState.buildings = result.buildings || [];
        appState.apartments = result.apartments || [];
        appState.templates = result.templates || [];
        appState.assets = result.assets || [];
        appState.staff = result.staff || [];
        appState.plans = result.plans || [];
        renderSession(result.currentUser || appState.currentUser);
        renderBoard();
        handleMaintenanceLinkTarget();
        document.getElementById('maintenance-content').hidden = false;
    } catch (error) {
        if ((error.message || '').includes('Kein Zugriff')) {
            document.getElementById('access-denied').hidden = false;
            return;
        }
        showAlert(error.message || 'Board konnte nicht geladen werden.', 'error');
    }
}

function renderSession(user) {
    document.getElementById('session-user').textContent = getVisibleName(user);
    document.getElementById('session-role').textContent = user.role === 'admin' ? 'Administrator' : 'Board-Benutzer';
    const testMailButton = document.getElementById('maintenance-test-mail-btn');
    if (testMailButton) {
        testMailButton.hidden = user.role !== 'admin';
    }
}

function renderBoard() {
    renderSummary();
    renderBuildings();
    renderApartments();
    renderTemplates();
    renderAssets();
    renderStaff();
    renderCalendar();
    renderPlans();
    fillBuildingSelects();
    fillTemplateSelect();
    fillAssetSelect();
    fillCalendarAssetSelect();
    fillStaffSelects();
    renderTemplateCategorySuggestions();
    renderChecklistEditor('template');
    renderChecklistEditor('plan');
    syncApartmentOptions();
    renderPlanFocusState();
    renderTemplateFileList();
}

function handleMaintenanceLinkTarget() {
    const params = new URLSearchParams(window.location.search);
    const planId = Number(params.get('plan') || 0);
    const assetId = Number(params.get('asset') || 0);
    if (planId) {
        const plan = appState.plans.find((item) => Number(item.id) === planId);
        if (plan) {
            editPlan(planId);
            return;
        }
    }
    if (!assetId) return;

    const candidates = appState.plans
        .filter((item) => item.active && Number(item.asset_id) === assetId)
        .sort((left, right) => {
            const leftState = getPlanDueRank(left);
            const rightState = getPlanDueRank(right);
            if (leftState !== rightState) return leftState - rightState;
            return compareDates(left.next_due_date, right.next_due_date);
        });
    if (candidates.length) {
        editPlan(candidates[0].id);
        showAlert('Passende offene Wartung für dieses Gerät geöffnet.', 'success');
        return;
    }

    const asset = appState.assets.find((item) => Number(item.id) === assetId);
    if (asset) {
        editAsset(assetId);
        showAlert('Für dieses Gerät ist aktuell kein offener Wartungsplan vorhanden.', 'error');
    }
}

function renderSummary() {
    document.getElementById('summary-buildings').textContent = appState.summary.buildings || 0;
    document.getElementById('summary-apartments').textContent = appState.summary.apartments || 0;
    document.getElementById('summary-assets').textContent = appState.summary.assets || 0;
    document.getElementById('summary-active-plans').textContent = appState.summary.activePlans || 0;
    document.getElementById('summary-due-soon').textContent = appState.summary.dueSoonPlans || 0;
    document.getElementById('summary-overdue').textContent = appState.summary.overduePlans || 0;

    const topPlans = [...appState.plans]
        .filter((plan) => plan.active)
        .filter((plan) => matchesSearch([
            plan.title,
            plan.template_name,
            plan.asset_name,
            plan.building_name,
            plan.apartment_name,
            plan.tenant_name,
            plan.staff_name,
            plan.responsible,
            plan.instructions,
            plan.last_completion_note
        ], appState.filters.dashboard))
        .sort((a, b) => compareDates(a.next_due_date, b.next_due_date))
        .slice(0, 10);

    const body = document.getElementById('dashboard-plans-body');
    if (!topPlans.length) {
        body.innerHTML = `<tr><td colspan="6" class="muted-copy">Noch keine Wartungspläne vorhanden.</td></tr>`;
        return;
    }

    body.innerHTML = topPlans.map((plan) => `
        <tr class="clickable-row" onclick="editPlan(${plan.id})">
            <td>
                <strong>${escapeHtml(plan.title)}</strong>
                <div class="muted-copy">${escapeHtml(plan.template_name || '')}</div>
            </td>
            <td>${escapeHtml(plan.asset_name || '-')}</td>
            <td>${escapeHtml(plan.building_name || '-')}</td>
            <td>${formatDate(plan.next_due_date)}</td>
            <td>${renderPriority(plan.priority)}</td>
            <td>
                <div class="table-actions">
                    <button class="mini-btn" onclick="event.stopPropagation(); editPlan(${plan.id})">Öffnen</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderBuildings() {
    const body = document.getElementById('buildings-body');
    const filteredBuildings = appState.buildings.filter((building) => matchesSearch([
        building.name,
        building.code,
        building.address,
        building.city,
        building.notes
    ], appState.filters.buildings));
    if (!filteredBuildings.length) {
        body.innerHTML = `<tr><td colspan="6" class="muted-copy">Noch keine Gebäude angelegt.</td></tr>`;
        return;
    }
    body.innerHTML = filteredBuildings.map((building) => `
        <tr class="clickable-row" onclick="editBuilding(${building.id})">
            <td><strong>${escapeHtml(building.name)}</strong></td>
            <td>${escapeHtml(building.code || '-')}</td>
            <td>${escapeHtml(building.city || '-')}</td>
            <td>${building.apartment_count || 0}</td>
            <td>${building.asset_count || 0}</td>
            <td>
                <div class="table-actions">
                    <button class="mini-btn" onclick="event.stopPropagation(); editBuilding(${building.id})">Bearbeiten</button>
                    <button class="mini-btn danger" onclick="event.stopPropagation(); deleteBuilding(${building.id})">Löschen</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderApartments() {
    const body = document.getElementById('apartments-body');
    const filteredApartments = appState.apartments.filter((apartment) => matchesSearch([
        apartment.building_name,
        apartment.name,
        apartment.floor,
        apartment.unit_number,
        apartment.tenant_name,
        apartment.notes
    ], appState.filters.apartments));
    if (!filteredApartments.length) {
        body.innerHTML = `<tr><td colspan="6" class="muted-copy">Noch keine Apartments angelegt.</td></tr>`;
        return;
    }
    body.innerHTML = filteredApartments.map((apartment) => `
        <tr class="clickable-row" onclick="editApartment(${apartment.id})">
            <td>${escapeHtml(apartment.building_name || '-')}</td>
            <td><strong>${escapeHtml(apartment.name)}</strong><div class="muted-copy">${escapeHtml(apartment.unit_number || '')}</div></td>
            <td>${escapeHtml(apartment.floor || '-')}</td>
            <td>${escapeHtml(apartment.tenant_name || '-')}</td>
            <td>${apartment.asset_count || 0}</td>
            <td>
                <div class="table-actions">
                    <button class="mini-btn" onclick="event.stopPropagation(); editApartment(${apartment.id})">Bearbeiten</button>
                    <button class="mini-btn" onclick="event.stopPropagation(); openApartmentLabelPrint(${apartment.id})">QR Labels</button>
                    <button class="mini-btn danger" onclick="event.stopPropagation(); deleteApartment(${apartment.id})">Löschen</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderTemplates() {
    const body = document.getElementById('templates-body');
    const filteredTemplates = appState.templates.filter((template) => matchesSearch([
        template.name,
        template.category,
        template.manufacturer,
        template.description,
        template.checklist,
        ...(template.files || []).map((file) => file.original_name)
    ], appState.filters.templates));
    if (!filteredTemplates.length) {
        body.innerHTML = `<tr><td colspan="6" class="muted-copy">Noch keine Stammdaten angelegt.</td></tr>`;
        return;
    }
    body.innerHTML = filteredTemplates.map((template) => `
        <tr class="clickable-row" onclick="editTemplate(${template.id})">
            <td><strong>${escapeHtml(template.name)}</strong></td>
            <td>${escapeHtml(template.category || '-')}</td>
            <td>${template.default_interval_days || 0} Tage</td>
            <td>${template.active ? 'Ja' : 'Nein'}</td>
            <td>${template.asset_count || 0}</td>
            <td>
                <div class="table-actions">
                    <button class="mini-btn" onclick="event.stopPropagation(); editTemplate(${template.id})">Bearbeiten</button>
                    <button class="mini-btn danger" onclick="event.stopPropagation(); deleteTemplate(${template.id})">Löschen</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderAssets() {
    const body = document.getElementById('assets-body');
    const filteredAssets = appState.assets.filter((asset) => matchesSearch([
        asset.name,
        asset.location,
        asset.serial_number,
        asset.template_name,
        asset.building_name,
        asset.apartment_name,
        asset.notes
    ], appState.filters.assets));
    if (!filteredAssets.length) {
        body.innerHTML = `<tr><td colspan="7" class="muted-copy">Noch keine Wartungsobjekte angelegt.</td></tr>`;
        return;
    }
    body.innerHTML = filteredAssets.map((asset) => `
        <tr class="clickable-row" onclick="editAsset(${asset.id})">
            <td><strong>${escapeHtml(asset.name)}</strong><div class="muted-copy">${escapeHtml(asset.location || '')}</div></td>
            <td>${escapeHtml(asset.template_name || '-')}</td>
            <td>${escapeHtml(asset.building_name || '-')}</td>
            <td>${escapeHtml(asset.apartment_name || '-')}</td>
            <td><span class="status-pill">${escapeHtml(asset.status || 'active')}</span></td>
            <td>${asset.plan_count || 0}</td>
            <td>
                <div class="table-actions">
                    <button class="mini-btn" onclick="event.stopPropagation(); editAsset(${asset.id})">Bearbeiten</button>
                    <button class="mini-btn" onclick="event.stopPropagation(); openAssetLabelPrint(${asset.id})">QR</button>
                    <button class="mini-btn danger" onclick="event.stopPropagation(); deleteAsset(${asset.id})">Löschen</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderStaff() {
    const body = document.getElementById('staff-body');
    const filteredStaff = appState.staff.filter((member) => matchesSearch([
        member.name,
        member.role,
        member.email,
        member.phone,
        member.notes
    ], appState.filters.staff));
    if (!filteredStaff.length) {
        body.innerHTML = `<tr><td colspan="5" class="muted-copy">Noch keine Mitarbeiter angelegt.</td></tr>`;
        return;
    }
    body.innerHTML = filteredStaff.map((member) => `
        <tr class="clickable-row" onclick="editStaff(${member.id})">
            <td>
                <strong>${escapeHtml(member.name)}</strong>
                <div class="muted-copy">${member.active ? 'Aktiv' : 'Inaktiv'}</div>
            </td>
            <td>${escapeHtml(member.role || '-')}</td>
            <td>${escapeHtml(member.email || member.phone || '-')}</td>
            <td>${member.plan_count || 0}</td>
            <td>
                <div class="table-actions">
                    <button class="mini-btn" onclick="event.stopPropagation(); editStaff(${member.id})">Bearbeiten</button>
                    <button class="mini-btn danger" onclick="event.stopPropagation(); deleteStaff(${member.id})">Löschen</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderCalendar() {
    updateCalendarControls();
    const surface = document.getElementById('calendar-surface');
    const view = appState.calendarView;
    if (view === 'day') {
        surface.innerHTML = renderDayCalendar();
        return;
    }
    if (view === 'week') {
        surface.innerHTML = renderWeekCalendar();
        return;
    }
    surface.innerHTML = renderMonthCalendar();
}

function renderPlans() {
    const body = document.getElementById('plans-body');
    const filteredPlans = appState.plans.filter((plan) => matchesSearch([
        plan.title,
        plan.asset_name,
        plan.building_name,
        plan.apartment_name,
        plan.tenant_name,
        plan.template_name,
        plan.staff_name,
        plan.responsible,
        plan.priority,
        plan.instructions,
        plan.last_completion_note
    ], appState.filters.plans));
    if (!filteredPlans.length) {
        body.innerHTML = `<tr><td colspan="7" class="muted-copy">Noch keine Wartungspläne angelegt.</td></tr>`;
        return;
    }
    body.innerHTML = filteredPlans.map((plan) => `
        <tr class="clickable-row" onclick="editPlan(${plan.id})">
            <td><strong>${escapeHtml(plan.title)}</strong></td>
            <td>${escapeHtml(plan.asset_name || '-')}</td>
            <td>${escapeHtml(plan.building_name || '-')}</td>
            <td>${formatDate(plan.next_due_date)}</td>
            <td>${escapeHtml(getResponsibleLabel(plan))}</td>
            <td>${renderPriority(plan.priority)}</td>
            <td>
                <div class="table-actions">
                    <button class="mini-btn" onclick="event.stopPropagation(); editPlan(${plan.id})">Öffnen</button>
                    <button class="mini-btn danger" onclick="event.stopPropagation(); deletePlan(${plan.id})">Löschen</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderPlanFocusState() {
    const listSurface = document.getElementById('plans-list-surface');
    const closeBtn = document.getElementById('plan-close-btn');
    const docsPanel = document.getElementById('plan-linked-docs');
    const workflow = document.getElementById('plan-completion-workflow');
    const checklistPanel = document.getElementById('plan-completion-checklist-panel');
    const requiredHint = document.getElementById('plan-photo-required-hint');
    const openedPlan = appState.plans.find((item) => Number(item.id) === Number(appState.openedPlanId));

    if (listSurface) listSurface.hidden = false;
    if (closeBtn) closeBtn.style.display = openedPlan ? 'inline-flex' : 'none';

    if (workflow) workflow.hidden = !openedPlan;
    if (requiredHint) {
        requiredHint.textContent = openedPlan?.completion_requires_photo
            ? 'Fuer diese Wartung ist mindestens ein Foto Pflicht.'
            : 'Fotos sind optional, solange der Plan nichts anderes vorgibt.';
    }
    if (checklistPanel) {
        renderCompletionChecklist(openedPlan);
    }

    if (!docsPanel) return;
    if (!openedPlan) {
        docsPanel.hidden = true;
        docsPanel.innerHTML = '';
        const historyPanel = document.getElementById('plan-completion-history');
        if (historyPanel) {
            historyPanel.hidden = true;
            historyPanel.innerHTML = '';
        }
        return;
    }

    const files = openedPlan.template_files || [];
    const checklist = String(openedPlan.template_checklist || '').trim();
    const description = String(openedPlan.template_description || '').trim();

    docsPanel.hidden = false;
    docsPanel.innerHTML = `
        <div class="surface-header">
            <h3>Geräteunterlagen</h3>
            <span>${escapeHtml(openedPlan.template_name || openedPlan.asset_name || 'Wartungsobjekt')}</span>
        </div>
        ${description ? `<div class="muted-copy">${escapeHtml(description)}</div>` : ''}
        ${checklist ? `<div class="muted-copy">${escapeHtml(checklist).replace(/\n/g, '<br>')}</div>` : ''}
        ${
            files.length
                ? files.map((file) => renderLinkedDocItem(file)).join('')
                : '<div class="muted-copy">Für dieses Gerät sind noch keine Bilder oder Anleitungen hinterlegt.</div>'
        }
    `;
}

function renderCompletionChecklist(plan) {
    const panel = document.getElementById('plan-completion-checklist-panel');
    if (!panel) return;
    const items = getCompletionChecklistItems(plan?.completion_checklist || '');
    if (!plan || !items.length) {
        panel.hidden = true;
        panel.innerHTML = '';
        appState.completionChecklistState = [];
        return;
    }
    const stateMap = new Map(appState.completionChecklistState.map((entry) => [String(entry.label), !!entry.checked]));
    appState.completionChecklistState = items.map((label) => ({
        label,
        checked: stateMap.has(label) ? stateMap.get(label) : false
    }));
    panel.hidden = false;
    panel.innerHTML = `
        <div class="surface-header compact">
            <h3>Checkliste</h3>
            <span>Alles abhaken, bevor du abschließt</span>
        </div>
        <div class="completion-checklist">
            ${appState.completionChecklistState.map((entry, index) => `
                <label class="completion-check-item">
                    <input type="checkbox" ${entry.checked ? 'checked' : ''} onchange="toggleCompletionChecklistItem(${index}, this.checked)">
                    <span>${escapeHtml(entry.label)}</span>
                </label>
            `).join('')}
        </div>
    `;
}

function renderLinkedDocItem(file) {
    const mime = String(file.mime_type || '').toLowerCase();
    const isImage = mime.startsWith('image/');
    const preview = isImage
        ? `<img class="linked-doc-thumb" src="${escapeHtml(file.url)}" alt="${escapeHtml(file.original_name)}">`
        : `<div class="linked-doc-thumb" style="display:flex;align-items:center;justify-content:center;font-size:0.75rem;">DOC</div>`;
    return `
        <div class="linked-doc-item">
            <div class="linked-doc-item-preview">
                ${preview}
                <div class="linked-doc-meta">
                    <strong>${escapeHtml(file.original_name)}</strong>
                    <span>${escapeHtml(file.mime_type || 'Datei')}</span>
                </div>
            </div>
            <a class="action-btn secondary" href="${escapeHtml(file.url)}" target="_blank" rel="noopener noreferrer">Öffnen</a>
        </div>
    `;
}

function renderCompletionHistory(completions) {
    const panel = document.getElementById('plan-completion-history');
    if (!panel) return;
    if (!completions || !completions.length) {
        panel.hidden = true;
        panel.innerHTML = '';
        return;
    }
    panel.hidden = false;
    panel.innerHTML = `
        <div class="surface-header">
            <h3>Letzte Durchfuehrungen</h3>
            <span>${completions.length} Eintraege</span>
        </div>
        ${completions.slice(0, 5).map((completion) => `
            <div class="completion-history-item">
                <div class="completion-history-head">
                    <strong>${formatDate(completion.completed_at)}</strong>
                    <span>${completion.photos?.length || 0} Foto(s)</span>
                </div>
                ${completion.completion_note ? `<div class="muted-copy">${escapeHtml(completion.completion_note)}</div>` : ''}
                ${completion.signature_url ? `<a class="mini-btn" href="${escapeHtml(completion.signature_url)}" target="_blank" rel="noopener noreferrer">Unterschrift</a>` : ''}
                ${
                    completion.photos?.length
                        ? `<div class="completion-photo-grid">${completion.photos.map((photo) => `
                            <a class="completion-photo-tile" href="${escapeHtml(photo.url)}" target="_blank" rel="noopener noreferrer">
                                <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.original_name)}">
                            </a>
                        `).join('')}</div>`
                        : ''
                }
            </div>
        `).join('')}
    `;
}

function fillBuildingSelects() {
    const options = ['<option value="">Bitte wählen</option>']
        .concat(appState.buildings.map((building) => `<option value="${building.id}">${escapeHtml(building.name)}</option>`))
        .join('');
    document.getElementById('apartment-building').innerHTML = options;
    document.getElementById('asset-building').innerHTML = options;
}

function fillTemplateSelect() {
    const select = document.getElementById('asset-template');
    select.innerHTML = ['<option value="">Bitte wählen</option>']
        .concat(appState.templates.map((template) => `<option value="${template.id}">${escapeHtml(template.name)}</option>`))
        .join('');
}

function fillAssetSelect() {
    const select = document.getElementById('plan-asset');
    select.innerHTML = ['<option value="">Bitte wählen</option>']
        .concat(appState.assets.map((asset) => `<option value="${asset.id}">${escapeHtml(asset.name)} - ${escapeHtml(asset.building_name || '')}</option>`))
        .join('');
}

function fillCalendarAssetSelect() {
    const select = document.getElementById('calendar-plan-asset');
    select.innerHTML = ['<option value="">Bitte wählen</option>']
        .concat(appState.assets.map((asset) => `<option value="${asset.id}">${escapeHtml(asset.name)} - ${escapeHtml(asset.building_name || '')}</option>`))
        .join('');
    document.getElementById('calendar-plan-date').value = appState.selectedDate || new Date().toISOString().slice(0, 10);
}

function fillStaffSelects() {
    const planSelect = document.getElementById('plan-staff');
    const calendarSelect = document.getElementById('calendar-plan-staff');
    const currentPlanValue = planSelect ? planSelect.value : '';
    const currentCalendarValue = calendarSelect ? calendarSelect.value : '';
    const options = ['<option value="">Nicht zugewiesen</option>']
        .concat(appState.staff.map((member) => `<option value="${member.id}">${escapeHtml(member.name)}${member.role ? ` - ${escapeHtml(member.role)}` : ''}</option>`))
        .join('');
    if (planSelect) {
        planSelect.innerHTML = options;
        if ([...planSelect.options].some((option) => option.value === currentPlanValue)) {
            planSelect.value = currentPlanValue;
        }
    }
    if (calendarSelect) {
        calendarSelect.innerHTML = options;
        if ([...calendarSelect.options].some((option) => option.value === currentCalendarValue)) {
            calendarSelect.value = currentCalendarValue;
        }
    }
}

function renderTemplateCategorySuggestions() {
    const datalist = document.getElementById('template-category-options');
    if (!datalist) return;
    const categories = [...new Set(
        appState.templates
            .map((template) => String(template.category || '').trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }))
    )];
    datalist.innerHTML = categories.map((category) => `<option value="${escapeHtml(category)}"></option>`).join('');
}

function getCompletionChecklistItems(value) {
    return String(value || '')
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function getChecklistFieldId(scope) {
    return scope === 'template' ? 'template-checklist' : 'plan-completion-checklist';
}

function getChecklistInputId(scope) {
    return scope === 'template' ? 'template-checklist-input' : 'plan-checklist-input';
}

function getChecklistListId(scope) {
    return scope === 'template' ? 'template-checklist-list' : 'plan-checklist-list';
}

function renderChecklistEditor(scope) {
    const list = document.getElementById(getChecklistListId(scope));
    const source = document.getElementById(getChecklistFieldId(scope));
    if (!list || !source) return;
    const items = getCompletionChecklistItems(source.value);
    if (!items.length) {
        list.innerHTML = '<div class="muted-copy">Noch keine Checklistenpunkte angelegt.</div>';
        return;
    }
    list.innerHTML = items.map((item, index) => `
        <div class="checklist-editor-item">
            <span>${escapeHtml(item)}</span>
            <button type="button" class="mini-btn" onclick="moveChecklistItem('${scope}', ${index}, -1)">Hoch</button>
            <button type="button" class="mini-btn danger" onclick="removeChecklistItem('${scope}', ${index})">Löschen</button>
        </div>
    `).join('');
}

function setChecklistItems(scope, items) {
    const source = document.getElementById(getChecklistFieldId(scope));
    if (!source) return;
    source.value = items.join('\n');
    renderChecklistEditor(scope);
    if (scope === 'plan') {
        appState.completionChecklistState = items.map((label) => ({ label, checked: false }));
        renderCompletionChecklist({ completion_checklist: source.value });
    }
}

function addChecklistItem(scope) {
    const input = document.getElementById(getChecklistInputId(scope));
    const source = document.getElementById(getChecklistFieldId(scope));
    if (!input || !source) return;
    const value = String(input.value || '').trim();
    if (!value) return;
    const items = getCompletionChecklistItems(source.value);
    items.push(value);
    setChecklistItems(scope, items);
    input.value = '';
}

function removeChecklistItem(scope, index) {
    const source = document.getElementById(getChecklistFieldId(scope));
    if (!source) return;
    const items = getCompletionChecklistItems(source.value);
    items.splice(index, 1);
    setChecklistItems(scope, items);
}

function moveChecklistItem(scope, index, direction) {
    const source = document.getElementById(getChecklistFieldId(scope));
    if (!source) return;
    const items = getCompletionChecklistItems(source.value);
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= items.length) return;
    const [entry] = items.splice(index, 1);
    items.splice(targetIndex, 0, entry);
    setChecklistItems(scope, items);
}

function toggleCompletionChecklistItem(index, checked) {
    if (!appState.completionChecklistState[index]) return;
    appState.completionChecklistState[index].checked = !!checked;
}

function syncApartmentOptions() {
    const buildingId = Number(document.getElementById('asset-building').value || 0);
    const select = document.getElementById('asset-apartment');
    const options = ['<option value="">Kein Apartment</option>']
        .concat(
            appState.apartments
                .filter((apartment) => !buildingId || Number(apartment.building_id) === buildingId)
                .map((apartment) => `<option value="${apartment.id}">${escapeHtml(apartment.name)}</option>`)
        )
        .join('');
    const currentValue = select.value;
    select.innerHTML = options;
    if ([...select.options].some((option) => option.value === currentValue)) {
        select.value = currentValue;
    }
}

function getResponsibleLabel(plan) {
    const staffName = String(plan.staff_name || '').trim();
    const responsible = String(plan.responsible || '').trim();
    if (staffName && responsible) return `${staffName} / ${responsible}`;
    return staffName || responsible || '-';
}

function hydrateAssetFromTemplate() {
    const templateId = Number(document.getElementById('asset-template').value || 0);
    const template = appState.templates.find((item) => Number(item.id) === templateId);
    const nameInput = document.getElementById('asset-name');
    if (template && !nameInput.value.trim()) {
        nameInput.value = template.name || '';
    }
}

async function submitBuildingForm(event) {
    event.preventDefault();
    const id = document.getElementById('building-id').value;
    const payload = {
        requesterId: appState.currentUser.id,
        name: document.getElementById('building-name').value.trim(),
        code: document.getElementById('building-code').value.trim(),
        address: document.getElementById('building-address').value.trim(),
        city: document.getElementById('building-city').value.trim(),
        notes: document.getElementById('building-notes').value.trim()
    };
    await saveEntity(id ? `/api/maintenance/buildings/${id}` : '/api/maintenance/buildings', id ? 'PUT' : 'POST', payload, 'Gebäude gespeichert.');
    resetBuildingForm();
}

async function submitApartmentForm(event) {
    event.preventDefault();
    const id = document.getElementById('apartment-id').value;
    const payload = {
        requesterId: appState.currentUser.id,
        building_id: Number(document.getElementById('apartment-building').value || 0),
        name: document.getElementById('apartment-name').value.trim(),
        floor: document.getElementById('apartment-floor').value.trim(),
        unit_number: document.getElementById('apartment-unit-number').value.trim(),
        tenant_name: document.getElementById('apartment-tenant-name').value.trim(),
        notes: document.getElementById('apartment-notes').value.trim()
    };
    await saveEntity(id ? `/api/maintenance/apartments/${id}` : '/api/maintenance/apartments', id ? 'PUT' : 'POST', payload, 'Apartment gespeichert.');
    resetApartmentForm();
}

async function submitTemplateForm(event) {
    event.preventDefault();
    const id = document.getElementById('template-id').value;
    const payload = {
        requesterId: appState.currentUser.id,
        name: document.getElementById('template-name').value.trim(),
        category: document.getElementById('template-category').value.trim(),
        manufacturer: document.getElementById('template-manufacturer').value.trim(),
        default_interval_days: Number(document.getElementById('template-default-interval').value || 180),
        description: document.getElementById('template-description').value.trim(),
        checklist: document.getElementById('template-checklist').value.trim(),
        active: document.getElementById('template-active').checked
    };
    await saveEntity(id ? `/api/maintenance/templates/${id}` : '/api/maintenance/templates', id ? 'PUT' : 'POST', payload, 'Stammdatensatz gespeichert.');
    resetTemplateForm();
}

async function submitAssetForm(event) {
    event.preventDefault();
    const id = document.getElementById('asset-id').value;
    const apartmentValue = document.getElementById('asset-apartment').value;
    const payload = {
        requesterId: appState.currentUser.id,
        template_id: Number(document.getElementById('asset-template').value || 0),
        building_id: Number(document.getElementById('asset-building').value || 0),
        apartment_id: apartmentValue ? Number(apartmentValue) : null,
        name: document.getElementById('asset-name').value.trim(),
        location: document.getElementById('asset-location').value.trim(),
        serial_number: document.getElementById('asset-serial-number').value.trim(),
        status: document.getElementById('asset-status').value,
        installed_on: document.getElementById('asset-installed-on').value,
        notes: document.getElementById('asset-notes').value.trim()
    };
    await saveEntity(id ? `/api/maintenance/assets/${id}` : '/api/maintenance/assets', id ? 'PUT' : 'POST', payload, 'Wartungsobjekt gespeichert.');
    resetAssetForm();
}

async function submitStaffForm(event) {
    event.preventDefault();
    const id = document.getElementById('staff-id').value;
    const payload = {
        requesterId: appState.currentUser.id,
        name: document.getElementById('staff-name').value.trim(),
        role: document.getElementById('staff-role').value.trim(),
        email: document.getElementById('staff-email').value.trim(),
        phone: document.getElementById('staff-phone').value.trim(),
        notes: document.getElementById('staff-notes').value.trim(),
        active: document.getElementById('staff-active').checked
    };
    await saveEntity(id ? `/api/maintenance/staff/${id}` : '/api/maintenance/staff', id ? 'PUT' : 'POST', payload, 'Mitarbeiter gespeichert.');
    resetStaffForm();
}

async function submitPlanForm(event) {
    event.preventDefault();
    const id = document.getElementById('plan-id').value;
    const payload = {
        requesterId: appState.currentUser.id,
        asset_id: Number(document.getElementById('plan-asset').value || 0),
        title: document.getElementById('plan-title').value.trim(),
        interval_days: Number(document.getElementById('plan-interval-days').value || 180),
        next_due_date: document.getElementById('plan-next-due-date').value,
        last_completed_at: document.getElementById('plan-last-completed-at').value,
        last_completion_note: document.getElementById('plan-completion-note').value.trim(),
        completion_checklist: document.getElementById('plan-completion-checklist').value.trim(),
        completion_requires_photo: document.getElementById('plan-requires-photo').checked,
        responsible_staff_id: Number(document.getElementById('plan-staff').value || 0) || null,
        responsible: document.getElementById('plan-responsible').value.trim(),
        priority: document.getElementById('plan-priority').value,
        instructions: document.getElementById('plan-instructions').value.trim(),
        active: document.getElementById('plan-active').checked
    };
    await saveEntity(id ? `/api/maintenance/plans/${id}` : '/api/maintenance/plans', id ? 'PUT' : 'POST', payload, 'Wartungsplan gespeichert.');
    resetPlanForm();
}

async function submitCalendarQuickForm(event) {
    event.preventDefault();
    const payload = {
        requesterId: appState.currentUser.id,
        asset_id: Number(document.getElementById('calendar-plan-asset').value || 0),
        title: document.getElementById('calendar-plan-title').value.trim(),
        interval_days: Number(document.getElementById('calendar-plan-interval-days').value || 180),
        next_due_date: document.getElementById('calendar-plan-date').value,
        responsible_staff_id: Number(document.getElementById('calendar-plan-staff').value || 0) || null,
        responsible: document.getElementById('calendar-plan-responsible').value.trim(),
        priority: document.getElementById('calendar-plan-priority').value,
        instructions: '',
        active: true
    };
    await saveEntity('/api/maintenance/plans', 'POST', payload, 'Wartung im Kalender angelegt.');
    resetCalendarQuickForm();
    setActiveTab('calendar');
}

async function saveEntity(url, method, payload, successMessage) {
    try {
        await api(url, { method, body: payload });
        showAlert(successMessage, 'success');
        await reloadBoardData();
    } catch (error) {
        showAlert(error.message || 'Speichern fehlgeschlagen.', 'error');
    }
}

async function reloadBoardData() {
    const result = await api(`/api/maintenance/bootstrap?requesterId=${encodeURIComponent(appState.currentUser.id)}`);
    appState.summary = result.summary || {};
    appState.buildings = result.buildings || [];
    appState.apartments = result.apartments || [];
    appState.templates = result.templates || [];
    appState.assets = result.assets || [];
    appState.staff = result.staff || [];
    appState.plans = result.plans || [];
    renderBoard();
}

function resetBuildingForm() {
    document.getElementById('building-form').reset();
    document.getElementById('building-id').value = '';
}

function resetApartmentForm() {
    document.getElementById('apartment-form').reset();
    document.getElementById('apartment-id').value = '';
    fillBuildingSelects();
}

function resetTemplateForm() {
    document.getElementById('template-form').reset();
    document.getElementById('template-id').value = '';
    document.getElementById('template-default-interval').value = 180;
    document.getElementById('template-active').checked = true;
    document.getElementById('template-file-list').innerHTML = '';
    document.getElementById('template-file-upload').value = '';
    renderChecklistEditor('template');
}

function resetAssetForm() {
    document.getElementById('asset-form').reset();
    document.getElementById('asset-id').value = '';
    fillTemplateSelect();
    fillBuildingSelects();
    syncApartmentOptions();
    document.getElementById('asset-status').value = 'active';
}

function resetStaffForm() {
    document.getElementById('staff-form').reset();
    document.getElementById('staff-id').value = '';
    document.getElementById('staff-active').checked = true;
}

function resetPlanForm() {
    document.getElementById('plan-form').reset();
    document.getElementById('plan-id').value = '';
    appState.openedPlanId = null;
    appState.planCompletions = [];
    appState.completionChecklistState = [];
    appState.completionPhotoFiles = [];
    fillAssetSelect();
    fillStaffSelects();
    document.getElementById('plan-interval-days').value = 180;
    document.getElementById('plan-priority').value = 'normal';
    document.getElementById('plan-active').checked = true;
    document.getElementById('plan-requires-photo').checked = false;
    document.getElementById('plan-complete-btn').style.display = 'none';
    document.getElementById('plan-completion-photos').value = '';
    renderChecklistEditor('plan');
    renderCompletionPhotoPreview();
    clearPlanSignature();
    renderPlanFocusState();
}

function resetCalendarQuickForm() {
    document.getElementById('calendar-quick-form').reset();
    fillStaffSelects();
    document.getElementById('calendar-plan-date').value = appState.selectedDate || new Date().toISOString().slice(0, 10);
    document.getElementById('calendar-plan-interval-days').value = 180;
    document.getElementById('calendar-plan-priority').value = 'normal';
}

function editBuilding(id) {
    const building = appState.buildings.find((item) => Number(item.id) === Number(id));
    if (!building) return;
    setActiveTab('buildings');
    document.getElementById('building-id').value = building.id;
    document.getElementById('building-name').value = building.name || '';
    document.getElementById('building-code').value = building.code || '';
    document.getElementById('building-address').value = building.address || '';
    document.getElementById('building-city').value = building.city || '';
    document.getElementById('building-notes').value = building.notes || '';
}

function editApartment(id) {
    const apartment = appState.apartments.find((item) => Number(item.id) === Number(id));
    if (!apartment) return;
    setActiveTab('apartments');
    document.getElementById('apartment-id').value = apartment.id;
    document.getElementById('apartment-building').value = apartment.building_id || '';
    document.getElementById('apartment-name').value = apartment.name || '';
    document.getElementById('apartment-floor').value = apartment.floor || '';
    document.getElementById('apartment-unit-number').value = apartment.unit_number || '';
    document.getElementById('apartment-tenant-name').value = apartment.tenant_name || '';
    document.getElementById('apartment-notes').value = apartment.notes || '';
}

function editTemplate(id) {
    const template = appState.templates.find((item) => Number(item.id) === Number(id));
    if (!template) return;
    setActiveTab('templates');
    document.getElementById('template-id').value = template.id;
    document.getElementById('template-name').value = template.name || '';
    document.getElementById('template-category').value = template.category || '';
    document.getElementById('template-manufacturer').value = template.manufacturer || '';
    document.getElementById('template-default-interval').value = template.default_interval_days || 180;
    document.getElementById('template-description').value = template.description || '';
    document.getElementById('template-checklist').value = template.checklist || '';
    document.getElementById('template-active').checked = !!template.active;
    renderChecklistEditor('template');
    renderTemplateFileList();
}

function editAsset(id) {
    const asset = appState.assets.find((item) => Number(item.id) === Number(id));
    if (!asset) return;
    setActiveTab('assets');
    document.getElementById('asset-id').value = asset.id;
    document.getElementById('asset-template').value = asset.template_id || '';
    document.getElementById('asset-building').value = asset.building_id || '';
    syncApartmentOptions();
    document.getElementById('asset-apartment').value = asset.apartment_id || '';
    document.getElementById('asset-name').value = asset.name || '';
    document.getElementById('asset-location').value = asset.location || '';
    document.getElementById('asset-serial-number').value = asset.serial_number || '';
    document.getElementById('asset-status').value = asset.status || 'active';
    document.getElementById('asset-installed-on').value = asset.installed_on || '';
    document.getElementById('asset-notes').value = asset.notes || '';
}

function editStaff(id) {
    const member = appState.staff.find((item) => Number(item.id) === Number(id));
    if (!member) return;
    setActiveTab('staff');
    document.getElementById('staff-id').value = member.id;
    document.getElementById('staff-name').value = member.name || '';
    document.getElementById('staff-role').value = member.role || '';
    document.getElementById('staff-email').value = member.email || '';
    document.getElementById('staff-phone').value = member.phone || '';
    document.getElementById('staff-notes').value = member.notes || '';
    document.getElementById('staff-active').checked = !!member.active;
}

function editPlan(id) {
    const plan = appState.plans.find((item) => Number(item.id) === Number(id));
    if (!plan) return;
    appState.openedPlanId = Number(id);
    appState.completionChecklistState = getCompletionChecklistItems(plan.completion_checklist || '').map((label) => ({ label, checked: false }));
    setActiveTab('plans');
    document.getElementById('plan-id').value = plan.id;
    document.getElementById('plan-asset').value = plan.asset_id || '';
    document.getElementById('plan-title').value = plan.title || '';
    document.getElementById('plan-interval-days').value = plan.interval_days || 180;
    document.getElementById('plan-next-due-date').value = plan.next_due_date || '';
    document.getElementById('plan-last-completed-at').value = plan.last_completed_at || '';
    document.getElementById('plan-completion-note').value = plan.last_completion_note || '';
    document.getElementById('plan-completion-checklist').value = plan.completion_checklist || '';
    document.getElementById('plan-requires-photo').checked = !!plan.completion_requires_photo;
    renderChecklistEditor('plan');
    document.getElementById('plan-staff').value = plan.responsible_staff_id || '';
    document.getElementById('plan-responsible').value = plan.responsible || '';
    document.getElementById('plan-priority').value = plan.priority || 'normal';
    document.getElementById('plan-instructions').value = plan.instructions || '';
    document.getElementById('plan-active').checked = !!plan.active;
    document.getElementById('plan-complete-btn').style.display = 'inline-flex';
    appState.completionPhotoFiles = [];
    document.getElementById('plan-completion-photos').value = '';
    renderCompletionPhotoPreview();
    clearPlanSignature();
    renderPlanFocusState();
    loadPlanCompletionHistory(plan.id);
}

function closeOpenedPlan() {
    resetPlanForm();
}

async function deleteBuilding(id) {
    if (!confirm('Gebäude wirklich löschen?')) return;
    await deleteEntity(`/api/maintenance/buildings/${id}`);
}

async function deleteApartment(id) {
    if (!confirm('Apartment wirklich löschen?')) return;
    await deleteEntity(`/api/maintenance/apartments/${id}`);
}

async function deleteTemplate(id) {
    if (!confirm('Stammdatensatz wirklich löschen?')) return;
    await deleteEntity(`/api/maintenance/templates/${id}`);
}

async function deleteAsset(id) {
    if (!confirm('Wartungsobjekt wirklich löschen?')) return;
    await deleteEntity(`/api/maintenance/assets/${id}`);
}

async function deleteStaff(id) {
    if (!confirm('Mitarbeiter wirklich löschen?')) return;
    await deleteEntity(`/api/maintenance/staff/${id}`);
}

async function deletePlan(id) {
    if (!confirm('Wartungsplan wirklich löschen?')) return;
    await deleteEntity(`/api/maintenance/plans/${id}`);
}

async function loadPlanCompletionHistory(planId) {
    try {
        const result = await api(`/api/maintenance/plans/${planId}/completions?requesterId=${encodeURIComponent(appState.currentUser.id)}`);
        appState.planCompletions = result.completions || [];
        renderCompletionHistory(appState.planCompletions);
    } catch (error) {
        renderCompletionHistory([]);
    }
}

function setCalendarView(view) {
    appState.calendarView = view;
    renderCalendar();
}

function updateCalendarControls() {
    document.querySelectorAll('.segment-btn').forEach((button) => {
        button.classList.toggle('active', button.dataset.calendarView === appState.calendarView);
    });

    fillCalendarJumpSelects();

    const selected = getSelectedDate();
    document.getElementById('calendar-plan-date').value = appState.selectedDate || selected;

    let label = '';
    if (appState.calendarView === 'day') {
        label = formatDate(selected);
    } else if (appState.calendarView === 'week') {
        const start = startOfWeek(appState.calendarDate);
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        label = `${formatDate(start.toISOString().slice(0, 10))} bis ${formatDate(end.toISOString().slice(0, 10))}`;
    } else {
        label = appState.calendarDate.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    }
    document.getElementById('calendar-range-label').textContent = label;
    document.getElementById('calendar-range-subtitle').textContent = appState.filters.calendar
        ? `Gefiltert nach: ${appState.filters.calendar}`
        : 'Fällige Wartungen im gewählten Zeitraum';
}

function shiftCalendarRange(direction) {
    if (appState.calendarView === 'day') {
        appState.calendarDate.setDate(appState.calendarDate.getDate() + direction);
    } else if (appState.calendarView === 'week') {
        appState.calendarDate.setDate(appState.calendarDate.getDate() + (7 * direction));
    } else {
        appState.calendarDate.setMonth(appState.calendarDate.getMonth() + direction);
    }
    renderCalendar();
}

function goToCalendarToday() {
    appState.calendarDate = new Date();
    appState.selectedDate = new Date().toISOString().slice(0, 10);
    resetCalendarQuickForm();
    renderCalendar();
}

function fillCalendarJumpSelects() {
    const yearSelect = document.getElementById('calendar-year-select');
    const monthSelect = document.getElementById('calendar-month-select');
    const currentYear = appState.calendarDate.getFullYear();
    const currentMonth = appState.calendarDate.getMonth();
    const startYear = currentYear - 5;
    const endYear = currentYear + 8;

    yearSelect.innerHTML = Array.from({ length: endYear - startYear + 1 }, (_, index) => {
        const year = startYear + index;
        return `<option value="${year}">${year}</option>`;
    }).join('');

    monthSelect.innerHTML = Array.from({ length: 12 }, (_, index) => {
        const label = new Date(2026, index, 1).toLocaleDateString('de-DE', { month: 'long' });
        return `<option value="${index}">${label}</option>`;
    }).join('');

    yearSelect.value = String(currentYear);
    monthSelect.value = String(currentMonth);
}

function handleCalendarJumpChange() {
    const year = Number(document.getElementById('calendar-year-select').value);
    const month = Number(document.getElementById('calendar-month-select').value);
    const safeDate = Math.min(appState.calendarDate.getDate(), daysInMonth(year, month));
    appState.calendarDate = new Date(year, month, safeDate);
    renderCalendar();
}

function selectCalendarDate(dateString) {
    appState.selectedDate = dateString;
    document.getElementById('calendar-plan-date').value = dateString;
    renderCalendar();
}

function hydrateCalendarTitleFromAsset() {
    const assetId = Number(document.getElementById('calendar-plan-asset').value || 0);
    const asset = appState.assets.find((item) => Number(item.id) === assetId);
    const titleInput = document.getElementById('calendar-plan-title');
    if (!asset || titleInput.value.trim()) return;
    titleInput.value = `${asset.name} Wartung`;
    const template = appState.templates.find((item) => Number(item.id) === Number(asset.template_id));
    if (template && Number(document.getElementById('calendar-plan-interval-days').value || 0) === 180) {
        document.getElementById('calendar-plan-interval-days').value = template.default_interval_days || 180;
    }
}

function hydratePlanFromAsset() {
    const assetId = Number(document.getElementById('plan-asset').value || 0);
    const asset = appState.assets.find((item) => Number(item.id) === assetId);
    if (!asset) return;
    const titleInput = document.getElementById('plan-title');
    const instructionsInput = document.getElementById('plan-instructions');
    const intervalInput = document.getElementById('plan-interval-days');
    const checklistInput = document.getElementById('plan-completion-checklist');

    if (!titleInput.value.trim()) {
        titleInput.value = `${asset.name} Wartung`;
    }
    if (!instructionsInput.value.trim()) {
        instructionsInput.value = asset.template_checklist || asset.template_description || '';
    }
    if (!checklistInput.value.trim()) {
        checklistInput.value = asset.template_checklist || '';
        renderChecklistEditor('plan');
    }
    if (!Number(intervalInput.value || 0) || Number(intervalInput.value || 0) === 180) {
        intervalInput.value = asset.template_default_interval_days || 180;
    }
    appState.completionChecklistState = getCompletionChecklistItems(checklistInput.value).map((label) => ({ label, checked: false }));
    renderCompletionChecklist(appState.plans.find((item) => Number(item.id) === Number(appState.openedPlanId)) || { completion_checklist: checklistInput.value });
}

function getSelectedDate() {
    return appState.selectedDate || new Date().toISOString().slice(0, 10);
}

function renderMonthCalendar() {
    const current = new Date(appState.calendarDate);
    const firstOfMonth = new Date(current.getFullYear(), current.getMonth(), 1);
    const gridStart = startOfWeek(firstOfMonth);
    const weekdays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    const html = [];

    html.push('<div class="calendar-month-grid">');
    weekdays.forEach((day) => html.push(`<div class="calendar-weekday">${day}</div>`));

    for (let index = 0; index < 42; index += 1) {
        const date = new Date(gridStart);
        date.setDate(gridStart.getDate() + index);
        const iso = date.toISOString().slice(0, 10);
        const dayPlans = getPlansForDate(iso);
        const isOutside = date.getMonth() !== current.getMonth();
        const isSelected = iso === appState.selectedDate;
        html.push(`
            <div class="calendar-day-cell ${isOutside ? 'outside' : ''} ${isSelected ? 'selected' : ''}" onclick="selectCalendarDate('${iso}')">
                <div class="calendar-day-head">
                    <span class="calendar-day-number">${date.getDate()}</span>
                    <span class="muted-copy">${dayPlans.length || ''}</span>
                </div>
                <div class="calendar-day-events">
                    ${dayPlans.slice(0, 3).map(renderCalendarEventCard).join('')}
                    ${dayPlans.length > 3 ? `<div class="muted-copy">+ ${dayPlans.length - 3} weitere</div>` : ''}
                </div>
            </div>
        `);
    }

    html.push('</div>');
    return html.join('');
}

function renderWeekCalendar() {
    const start = startOfWeek(appState.calendarDate);
    const weekDates = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(start);
        date.setDate(start.getDate() + index);
        return date;
    });

    return `
        <div class="calendar-week-view">
            <div class="calendar-hour-label"></div>
            <div class="calendar-week-columns">
                ${weekDates.map((date) => `
                    <div class="calendar-week-header ${date.toISOString().slice(0, 10) === appState.selectedDate ? 'selected' : ''}">
                        <strong>${date.toLocaleDateString('de-DE', { weekday: 'short' })}</strong><br>
                        ${date.getDate()}.${date.getMonth() + 1}
                    </div>
                `).join('')}
            </div>
            <div class="calendar-hour-label">Ganztägig</div>
            <div class="calendar-week-columns">
                ${weekDates.map((date) => {
                    const iso = date.toISOString().slice(0, 10);
                    const plans = getPlansForDate(iso);
                    return `
                        <div class="calendar-week-column">
                            <div class="calendar-slot ${iso === appState.selectedDate ? 'selected' : ''}" onclick="selectCalendarDate('${iso}')">
                                ${plans.length ? plans.map(renderCalendarEventCard).join('') : '<div class="muted-copy">Keine Wartung</div>'}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function renderDayCalendar() {
    const iso = appState.calendarDate.toISOString().slice(0, 10);
    const plans = getPlansForDate(iso);
    return `
        <div class="calendar-day-summary">
            <strong>${formatDate(iso)}</strong>
            <span class="muted-copy">${plans.length} Wartungen</span>
        </div>
        <div class="calendar-day-view">
            <div class="calendar-hour-label">Ganztägig</div>
            <div class="calendar-slot ${iso === appState.selectedDate ? 'selected' : ''}" onclick="selectCalendarDate('${iso}')">
                ${plans.length ? plans.map(renderCalendarEventCard).join('') : '<div class="calendar-empty">Für diesen Tag ist noch keine Wartung geplant.</div>'}
            </div>
        </div>
    `;
}

function renderCalendarEventCard(plan) {
    const priority = String(plan.priority || 'normal').toLowerCase();
    const dueState = getPlanDueState(plan);
    return `
        <div class="calendar-event-card ${escapeHtml(priority)} ${escapeHtml(dueState)}" onclick="handleCalendarEventClick(event, ${plan.id})">
            <strong>${escapeHtml(plan.title)}</strong>
            <div>${escapeHtml(plan.asset_name || '-')}</div>
            <div class="muted-copy">${escapeHtml(plan.building_name || '-')}</div>
        </div>
    `;
}

function handleCalendarEventClick(event, planId) {
    if (event) event.stopPropagation();
    editPlan(planId);
}

function getPlansForDate(dateString) {
    return getFilteredCalendarPlans()
        .filter((plan) => plan.active && plan.next_due_date === dateString)
        .sort((a, b) => String(a.priority || '').localeCompare(String(b.priority || '')));
}

function getFilteredCalendarPlans() {
    return appState.plans.filter((plan) => matchesSearch([
        plan.title,
        plan.asset_name,
        plan.building_name,
        plan.apartment_name,
        plan.tenant_name,
        plan.template_name,
        plan.template_description,
        plan.template_checklist,
        plan.staff_name,
        plan.responsible,
        plan.priority,
        plan.instructions,
        plan.last_completion_note
    ], appState.filters.calendar));
}

function getPlanDueState(plan) {
    if (!plan || !plan.active || !plan.next_due_date) return '';
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dueDate = new Date(plan.next_due_date);
    if (Number.isNaN(dueDate.getTime())) return '';
    dueDate.setHours(0, 0, 0, 0);

    if (dueDate < today) {
        return 'overdue';
    }

    const soonLimit = new Date(today);
    soonLimit.setDate(soonLimit.getDate() + 30);
    if (dueDate <= soonLimit) {
        return 'due-soon';
    }

    return '';
}

function startOfWeek(baseDate) {
    const date = new Date(baseDate);
    const day = date.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + diff);
    return date;
}

function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
}

async function deleteEntity(url) {
    try {
        await api(url, { method: 'DELETE', body: { requesterId: appState.currentUser.id } });
        showAlert('Eintrag gelöscht.', 'success');
        await reloadBoardData();
    } catch (error) {
        showAlert(error.message || 'Löschen fehlgeschlagen.', 'error');
    }
}

async function completePlan(id) {
    try {
        await api(`/api/maintenance/plans/${id}/complete`, {
            method: 'POST',
            body: { requesterId: appState.currentUser.id }
        });
        showAlert('Wartung als erledigt markiert.', 'success');
        await reloadBoardData();
    } catch (error) {
        showAlert(error.message || 'Plan konnte nicht abgeschlossen werden.', 'error');
    }
}

async function completeOpenedPlan() {
    const id = Number(document.getElementById('plan-id').value || 0);
    if (!id) {
        showAlert('Bitte zuerst einen Wartungsplan öffnen.', 'error');
        return;
    }
    const plan = appState.plans.find((item) => Number(item.id) === id);
    const signatureDataUrl = getPlanSignatureDataUrl();
    if (!signatureDataUrl) {
        showAlert('Bitte zuerst unterschreiben.', 'error');
        return;
    }
    const photoFiles = [...appState.completionPhotoFiles];
    if (plan?.completion_requires_photo && !photoFiles.length) {
        showAlert('Fuer diese Wartung ist mindestens ein Foto Pflicht.', 'error');
        return;
    }
    const incompleteChecklistItem = appState.completionChecklistState.find((entry) => !entry.checked);
    if (incompleteChecklistItem) {
        showAlert(`Checkliste noch offen: ${incompleteChecklistItem.label}`, 'error');
        return;
    }
    try {
        const formData = new FormData();
        formData.append('requesterId', String(appState.currentUser.id));
        formData.append('completion_note', document.getElementById('plan-completion-note').value.trim());
        formData.append('signature_data_url', signatureDataUrl);
        formData.append('checklist_state', JSON.stringify(appState.completionChecklistState));
        for (const file of photoFiles) {
            formData.append('photos', file);
        }
        const response = await fetch(`/api/maintenance/plans/${id}/complete`, {
            method: 'POST',
            body: formData
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
            throw new Error(data.message || 'Plan konnte nicht abgeschlossen werden.');
        }
        showAlert('Wartung als erledigt markiert.', 'success');
        await reloadBoardData();
        editPlan(id);
    } catch (error) {
        showAlert(error.message || 'Plan konnte nicht abgeschlossen werden.', 'error');
    }
}

function renderTemplateFileList() {
    const list = document.getElementById('template-file-list');
    if (!list) return;
    const templateId = Number(document.getElementById('template-id').value || 0);
    const template = appState.templates.find((item) => Number(item.id) === templateId);
    const files = template?.files || [];
    if (!templateId) {
        list.innerHTML = '<div class="muted-copy">Bitte zuerst Stammdaten speichern oder einen vorhandenen Datensatz öffnen.</div>';
        return;
    }
    if (!files.length) {
        list.innerHTML = '<div class="muted-copy">Noch keine Dateien hinterlegt.</div>';
        return;
    }
    list.innerHTML = files.map((file) => `
        <div class="template-file-item">
            <div>
                <strong>${escapeHtml(file.original_name)}</strong>
                <span>${escapeHtml(file.mime_type || 'Datei')}</span>
            </div>
            <div class="table-actions">
                <a class="mini-btn" href="${escapeHtml(file.url)}" target="_blank" rel="noopener noreferrer">Öffnen</a>
                <button class="mini-btn danger" type="button" onclick="deleteTemplateFile(${templateId}, ${file.id})">Löschen</button>
            </div>
        </div>
    `).join('');
}

async function uploadTemplateFiles() {
    const templateId = Number(document.getElementById('template-id').value || 0);
    const input = document.getElementById('template-file-upload');
    const files = Array.from(input.files || []);
    if (!templateId) {
        showAlert('Bitte zuerst den Stammdatensatz speichern.', 'error');
        return;
    }
    if (!files.length) {
        showAlert('Bitte mindestens eine Datei auswählen.', 'error');
        return;
    }
    try {
        for (const file of files) {
            const formData = new FormData();
            formData.append('file', file);
            await fetch(`/api/maintenance/templates/${templateId}/files?requesterId=${encodeURIComponent(appState.currentUser.id)}`, {
                method: 'POST',
                body: formData
            });
        }
        input.value = '';
        showAlert('Dateien hochgeladen.', 'success');
        await reloadBoardData();
        document.getElementById('template-id').value = String(templateId);
        renderTemplateFileList();
    } catch (error) {
        showAlert('Dateien konnten nicht hochgeladen werden.', 'error');
    }
}

async function deleteTemplateFile(templateId, fileId) {
    try {
        await api(`/api/maintenance/templates/${templateId}/files/${fileId}`, {
            method: 'DELETE',
            body: { requesterId: appState.currentUser.id }
        });
        showAlert('Datei entfernt.', 'success');
        await reloadBoardData();
        document.getElementById('template-id').value = String(templateId);
        renderTemplateFileList();
        renderPlanFocusState();
    } catch (error) {
        showAlert(error.message || 'Datei konnte nicht gelöscht werden.', 'error');
    }
}

function bindTableSearch(elementId, filterKey) {
    const input = document.getElementById(elementId);
    if (!input) return;
    input.addEventListener('input', () => {
        appState.filters[filterKey] = String(input.value || '').trim().toLowerCase();
        renderBoard();
    });
}

function renderCompletionPhotoPreview() {
    const preview = document.getElementById('plan-completion-photo-preview');
    if (!preview) return;
    const files = appState.completionPhotoFiles || [];
    if (!files.length) {
        preview.innerHTML = '';
        return;
    }
    preview.innerHTML = files.map((file) => `
        <div class="completion-photo-tile">
            <img src="${escapeHtml(URL.createObjectURL(file))}" alt="${escapeHtml(file.name)}">
            <button type="button" class="completion-photo-remove" onclick="removeCompletionPhoto('${escapeHtml(file._drqId)}')">x</button>
        </div>
    `).join('');
}

function handleCompletionPhotoSelection(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    files.forEach((file, index) => {
        file._drqId = `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
        appState.completionPhotoFiles.push(file);
    });
    event.target.value = '';
    renderCompletionPhotoPreview();
}

function removeCompletionPhoto(photoId) {
    appState.completionPhotoFiles = (appState.completionPhotoFiles || []).filter((file) => String(file._drqId) !== String(photoId));
    renderCompletionPhotoPreview();
}

function clearCompletionPhotos() {
    appState.completionPhotoFiles = [];
    const input = document.getElementById('plan-completion-photos');
    if (input) input.value = '';
    renderCompletionPhotoPreview();
}

function initializeSignaturePad() {
    const canvas = document.getElementById('plan-signature-pad');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111827';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let drawing = false;

    const getPoint = (event) => {
        const rect = canvas.getBoundingClientRect();
        const source = event.touches?.[0] || event;
        return {
            x: ((source.clientX - rect.left) / rect.width) * canvas.width,
            y: ((source.clientY - rect.top) / rect.height) * canvas.height
        };
    };
    const start = (event) => {
        drawing = true;
        const point = getPoint(event);
        ctx.beginPath();
        ctx.moveTo(point.x, point.y);
        event.preventDefault();
    };
    const move = (event) => {
        if (!drawing) return;
        const point = getPoint(event);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
        event.preventDefault();
    };
    const stop = () => {
        drawing = false;
    };

    canvas.addEventListener('pointerdown', start);
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', stop);

    appState.signaturePad = { canvas, ctx };
}

function clearPlanSignature() {
    const signaturePad = appState.signaturePad;
    if (!signaturePad) return;
    signaturePad.ctx.clearRect(0, 0, signaturePad.canvas.width, signaturePad.canvas.height);
    signaturePad.ctx.fillStyle = '#ffffff';
    signaturePad.ctx.fillRect(0, 0, signaturePad.canvas.width, signaturePad.canvas.height);
}

function getPlanSignatureDataUrl() {
    const signaturePad = appState.signaturePad;
    if (!signaturePad) return '';
    const { canvas, ctx } = signaturePad;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let hasInk = false;
    for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] < 250 || pixels[index + 1] < 250 || pixels[index + 2] < 250) {
            hasInk = true;
            break;
        }
    }
    return hasInk ? canvas.toDataURL('image/png') : '';
}

function getPlanDueRank(plan) {
    const state = getPlanDueState(plan);
    if (state === 'overdue') return 0;
    if (state === 'due-soon') return 1;
    return 2;
}

function openAssetLabelPrint(assetId) {
    const resolvedAssetId = Number(assetId || document.getElementById('asset-id').value || 0);
    if (!resolvedAssetId) {
        showAlert('Bitte zuerst ein Wartungsobjekt auswählen.', 'error');
        return;
    }
    window.open(`/maintenance-labels.html?asset=${resolvedAssetId}`, '_blank', 'noopener');
}

function openApartmentLabelPrint(apartmentId) {
    window.open(`/maintenance-labels.html?apartment=${Number(apartmentId)}`, '_blank', 'noopener');
}

function matchesSearch(fields, term) {
    if (!term) return true;
    return fields.some((value) => String(value || '').toLowerCase().includes(term));
}

async function sendMaintenanceTestMail() {
    try {
        const result = await api('/api/maintenance/test-mail', {
            method: 'POST',
            body: { requesterId: appState.currentUser.id }
        });
        showAlert(result.message || 'Testmail wurde versendet.', 'success');
    } catch (error) {
        showAlert(error.message || 'Testmail konnte nicht versendet werden.', 'error');
    }
}

async function api(url, options = {}) {
    const response = await fetch(url, {
        method: options.method || 'GET',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) {
        throw new Error(data.message || 'Anfrage fehlgeschlagen.');
    }
    return data;
}

function showAlert(message, kind = 'success') {
    const alert = document.getElementById('maintenance-alert');
    alert.hidden = false;
    alert.className = `alert ${kind}`;
    alert.textContent = message;
    window.clearTimeout(showAlert.timer);
    showAlert.timer = window.setTimeout(() => {
        alert.hidden = true;
    }, 3600);
}

function getVisibleName(user) {
    if (!user) return 'Unbekannt';
    const displayName = String(user.display_name || user.displayName || '').trim();
    return displayName || user.username || 'Unbekannt';
}

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (match) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[match]));
}

function formatDate(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('de-DE');
}

function compareDates(a, b) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
}

function renderPriority(priority) {
    const key = String(priority || 'normal').toLowerCase();
    const labels = {
        low: 'Niedrig',
        normal: 'Normal',
        high: 'Hoch',
        critical: 'Kritisch'
    };
    return `<span class="priority-badge priority-${escapeHtml(key)}">${labels[key] || 'Normal'}</span>`;
}
