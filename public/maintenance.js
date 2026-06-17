const storageKey = 'icq_user';
const appState = {
    currentUser: null,
    summary: {},
    buildings: [],
    apartments: [],
    templates: [],
    assets: [],
    plans: [],
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
    document.getElementById('plan-form').addEventListener('submit', submitPlanForm);
    document.getElementById('calendar-quick-form').addEventListener('submit', submitCalendarQuickForm);
    document.getElementById('asset-building').addEventListener('change', syncApartmentOptions);
    document.getElementById('calendar-plan-asset').addEventListener('change', hydrateCalendarTitleFromAsset);
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
    renderCalendar();
    renderPlans();
    fillBuildingSelects();
    fillTemplateSelect();
    fillAssetSelect();
    fillCalendarAssetSelect();
    syncApartmentOptions();
}

function handleMaintenanceLinkTarget() {
    const params = new URLSearchParams(window.location.search);
    const planId = Number(params.get('plan') || 0);
    if (!planId) return;

    const plan = appState.plans.find((item) => Number(item.id) === planId);
    if (!plan) return;

    editPlan(planId);
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
        .sort((a, b) => compareDates(a.next_due_date, b.next_due_date))
        .slice(0, 10);

    const body = document.getElementById('dashboard-plans-body');
    if (!topPlans.length) {
        body.innerHTML = `<tr><td colspan="6" class="muted-copy">Noch keine Wartungspläne vorhanden.</td></tr>`;
        return;
    }

    body.innerHTML = topPlans.map((plan) => `
        <tr>
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
                    <button class="mini-btn" onclick="editPlan(${plan.id})">Öffnen</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderBuildings() {
    const body = document.getElementById('buildings-body');
    if (!appState.buildings.length) {
        body.innerHTML = `<tr><td colspan="6" class="muted-copy">Noch keine Gebäude angelegt.</td></tr>`;
        return;
    }
    body.innerHTML = appState.buildings.map((building) => `
        <tr>
            <td><strong>${escapeHtml(building.name)}</strong></td>
            <td>${escapeHtml(building.code || '-')}</td>
            <td>${escapeHtml(building.city || '-')}</td>
            <td>${building.apartment_count || 0}</td>
            <td>${building.asset_count || 0}</td>
            <td>
                <div class="table-actions">
                    <button class="mini-btn" onclick="editBuilding(${building.id})">Bearbeiten</button>
                    <button class="mini-btn danger" onclick="deleteBuilding(${building.id})">Löschen</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderApartments() {
    const body = document.getElementById('apartments-body');
    if (!appState.apartments.length) {
        body.innerHTML = `<tr><td colspan="6" class="muted-copy">Noch keine Apartments angelegt.</td></tr>`;
        return;
    }
    body.innerHTML = appState.apartments.map((apartment) => `
        <tr>
            <td>${escapeHtml(apartment.building_name || '-')}</td>
            <td><strong>${escapeHtml(apartment.name)}</strong><div class="muted-copy">${escapeHtml(apartment.unit_number || '')}</div></td>
            <td>${escapeHtml(apartment.floor || '-')}</td>
            <td>${escapeHtml(apartment.tenant_name || '-')}</td>
            <td>${apartment.asset_count || 0}</td>
            <td>
                <div class="table-actions">
                    <button class="mini-btn" onclick="editApartment(${apartment.id})">Bearbeiten</button>
                    <button class="mini-btn danger" onclick="deleteApartment(${apartment.id})">Löschen</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderTemplates() {
    const body = document.getElementById('templates-body');
    if (!appState.templates.length) {
        body.innerHTML = `<tr><td colspan="6" class="muted-copy">Noch keine Stammdaten angelegt.</td></tr>`;
        return;
    }
    body.innerHTML = appState.templates.map((template) => `
        <tr>
            <td><strong>${escapeHtml(template.name)}</strong></td>
            <td>${escapeHtml(template.category || '-')}</td>
            <td>${template.default_interval_days || 0} Tage</td>
            <td>${template.active ? 'Ja' : 'Nein'}</td>
            <td>${template.asset_count || 0}</td>
            <td>
                <div class="table-actions">
                    <button class="mini-btn" onclick="editTemplate(${template.id})">Bearbeiten</button>
                    <button class="mini-btn danger" onclick="deleteTemplate(${template.id})">Löschen</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderAssets() {
    const body = document.getElementById('assets-body');
    if (!appState.assets.length) {
        body.innerHTML = `<tr><td colspan="7" class="muted-copy">Noch keine Wartungsobjekte angelegt.</td></tr>`;
        return;
    }
    body.innerHTML = appState.assets.map((asset) => `
        <tr>
            <td><strong>${escapeHtml(asset.name)}</strong><div class="muted-copy">${escapeHtml(asset.location || '')}</div></td>
            <td>${escapeHtml(asset.template_name || '-')}</td>
            <td>${escapeHtml(asset.building_name || '-')}</td>
            <td>${escapeHtml(asset.apartment_name || '-')}</td>
            <td><span class="status-pill">${escapeHtml(asset.status || 'active')}</span></td>
            <td>${asset.plan_count || 0}</td>
            <td>
                <div class="table-actions">
                    <button class="mini-btn" onclick="editAsset(${asset.id})">Bearbeiten</button>
                    <button class="mini-btn danger" onclick="deleteAsset(${asset.id})">Löschen</button>
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
    if (!appState.plans.length) {
        body.innerHTML = `<tr><td colspan="7" class="muted-copy">Noch keine Wartungspläne angelegt.</td></tr>`;
        return;
    }
    body.innerHTML = appState.plans.map((plan) => `
        <tr>
            <td><strong>${escapeHtml(plan.title)}</strong></td>
            <td>${escapeHtml(plan.asset_name || '-')}</td>
            <td>${escapeHtml(plan.building_name || '-')}</td>
            <td>${formatDate(plan.next_due_date)}</td>
            <td>${escapeHtml(plan.responsible || '-')}</td>
            <td>${renderPriority(plan.priority)}</td>
            <td>
                <div class="table-actions">
                    <button class="mini-btn" onclick="editPlan(${plan.id})">Öffnen</button>
                    <button class="mini-btn danger" onclick="deletePlan(${plan.id})">Löschen</button>
                </div>
            </td>
        </tr>
    `).join('');
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
}

function resetAssetForm() {
    document.getElementById('asset-form').reset();
    document.getElementById('asset-id').value = '';
    fillTemplateSelect();
    fillBuildingSelects();
    syncApartmentOptions();
    document.getElementById('asset-status').value = 'active';
}

function resetPlanForm() {
    document.getElementById('plan-form').reset();
    document.getElementById('plan-id').value = '';
    fillAssetSelect();
    document.getElementById('plan-interval-days').value = 180;
    document.getElementById('plan-priority').value = 'normal';
    document.getElementById('plan-active').checked = true;
    document.getElementById('plan-complete-btn').style.display = 'none';
}

function resetCalendarQuickForm() {
    document.getElementById('calendar-quick-form').reset();
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

function editPlan(id) {
    const plan = appState.plans.find((item) => Number(item.id) === Number(id));
    if (!plan) return;
    setActiveTab('plans');
    document.getElementById('plan-id').value = plan.id;
    document.getElementById('plan-asset').value = plan.asset_id || '';
    document.getElementById('plan-title').value = plan.title || '';
    document.getElementById('plan-interval-days').value = plan.interval_days || 180;
    document.getElementById('plan-next-due-date').value = plan.next_due_date || '';
    document.getElementById('plan-last-completed-at').value = plan.last_completed_at || '';
    document.getElementById('plan-completion-note').value = plan.last_completion_note || '';
    document.getElementById('plan-responsible').value = plan.responsible || '';
    document.getElementById('plan-priority').value = plan.priority || 'normal';
    document.getElementById('plan-instructions').value = plan.instructions || '';
    document.getElementById('plan-active').checked = !!plan.active;
    document.getElementById('plan-complete-btn').style.display = 'inline-flex';
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

async function deletePlan(id) {
    if (!confirm('Wartungsplan wirklich löschen?')) return;
    await deleteEntity(`/api/maintenance/plans/${id}`);
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
    return `
        <div class="calendar-event-card ${escapeHtml(priority)}" onclick="handleCalendarEventClick(event, ${plan.id})">
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
    return appState.plans
        .filter((plan) => plan.active && plan.next_due_date === dateString)
        .sort((a, b) => String(a.priority || '').localeCompare(String(b.priority || '')));
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
    try {
        await api(`/api/maintenance/plans/${id}/complete`, {
            method: 'POST',
            body: {
                requesterId: appState.currentUser.id,
                completion_note: document.getElementById('plan-completion-note').value.trim()
            }
        });
        showAlert('Wartung als erledigt markiert.', 'success');
        await reloadBoardData();
        editPlan(id);
    } catch (error) {
        showAlert(error.message || 'Plan konnte nicht abgeschlossen werden.', 'error');
    }
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
