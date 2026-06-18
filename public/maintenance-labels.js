const storageKey = 'icq_user';

document.addEventListener('DOMContentLoaded', async () => {
    const saved = localStorage.getItem(storageKey);
    if (!saved) {
        document.getElementById('label-grid').innerHTML = '<div class="surface">Bitte zuerst in DRQ anmelden.</div>';
        return;
    }

    let currentUser = null;
    try {
        currentUser = JSON.parse(saved);
    } catch (error) {
        document.getElementById('label-grid').innerHTML = '<div class="surface">Anmeldung konnte nicht gelesen werden.</div>';
        return;
    }

    try {
        const result = await fetch(`/api/maintenance/bootstrap?requesterId=${encodeURIComponent(currentUser.id)}`);
        const data = await result.json();
        if (!result.ok || data.success === false) {
            throw new Error(data.message || 'QR Labels konnten nicht geladen werden.');
        }
        renderLabels(data.assets || [], data.apartments || [], data.buildings || []);
    } catch (error) {
        document.getElementById('label-grid').innerHTML = `<div class="surface">${escapeHtml(error.message || 'QR Labels konnten nicht geladen werden.')}</div>`;
    }
});

function renderLabels(assets, apartments) {
    const params = new URLSearchParams(window.location.search);
    const apartmentId = Number(params.get('apartment') || 0);
    const assetId = Number(params.get('asset') || 0);

    let targetAssets = assets;
    let subtitle = 'Alle Wartungsobjekte';

    if (apartmentId) {
        const apartment = apartments.find((item) => Number(item.id) === apartmentId);
        targetAssets = assets.filter((asset) => Number(asset.apartment_id) === apartmentId);
        subtitle = apartment ? `Apartment: ${apartment.name}` : `Apartment ${apartmentId}`;
    } else if (assetId) {
        targetAssets = assets.filter((asset) => Number(asset.id) === assetId);
        subtitle = targetAssets[0]?.name || `Wartungsobjekt ${assetId}`;
    }

    document.getElementById('label-subtitle').textContent = subtitle;
    const grid = document.getElementById('label-grid');
    if (!targetAssets.length) {
        grid.innerHTML = '<div class="surface">Keine Wartungsobjekte fuer diese Auswahl gefunden.</div>';
        return;
    }

    grid.innerHTML = targetAssets.map((asset) => {
        const link = `${window.location.origin}/maintenance.html?asset=${asset.id}`;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(link)}`;
        return `
            <div class="label-card">
                <strong>${escapeHtml(asset.name || 'Wartungsobjekt')}</strong>
                <div class="muted-copy">${escapeHtml(asset.building_name || '-')} / ${escapeHtml(asset.apartment_name || '-')}</div>
                <div class="muted-copy">${escapeHtml(asset.location || asset.template_name || '')}</div>
                <img src="${qrUrl}" alt="QR Code fuer ${escapeHtml(asset.name || 'Wartungsobjekt')}">
                <div class="label-link">${escapeHtml(link)}</div>
            </div>
        `;
    }).join('');
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
