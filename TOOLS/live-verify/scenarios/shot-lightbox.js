// Страховка лайтбокса скриншота: открытый он накрывает страницу целиком и
// ничего не добавляет ей в высоту.
//
// Проверка на ошибку, а не на «открылся»: без стилей (SYSTEM/styles/modal.css)
// узел #shotLightbox — обычный статичный блок, он и открывается, и показывает
// картинку — но внизу страницы, а документ становится выше окна. Именно это
// выглядело как «скриншоты не открываются» и «страница прокручивается» (v0.0.128).
//
// Картинку берём настоящую из миниатюры сессии, а когда её нет — рисуем
// холстом: правила лайтбокса не зависят от содержимого src.

async function scenario(P) {
    window.MissionTabs.show('chat');
    await new Promise((r) => setTimeout(r, 800));

    const lightbox = document.getElementById('shotLightbox');
    const image = document.getElementById('shotLightboxImg');
    if (!lightbox || !image) return { ok: false, error: 'на странице нет #shotLightbox' };

    const thumb = document.querySelector('.session-item__thumb-img');
    let src = thumb?.src;
    if (!src) {
        const canvas = document.createElement('canvas');
        canvas.width = 1200;
        canvas.height = 800;
        canvas.getContext('2d').fillRect(0, 0, 1200, 800);
        src = canvas.toDataURL('image/png');
    }

    const before = document.documentElement.scrollHeight;
    lightbox.hidden = false;
    image.src = src;
    await new Promise((r) => setTimeout(r, 400));

    const style = getComputedStyle(lightbox);
    const box = lightbox.getBoundingClientRect();
    const img = image.getBoundingClientRect();
    const after = document.documentElement.scrollHeight;

    const checks = {
        coversViewport: Math.round(box.width) >= innerWidth - 1 && Math.round(box.height) >= innerHeight - 1,
        fixedOnTop: style.position === 'fixed' && Number(style.zIndex) > 0,
        imageFitsInside: img.width > 0 && img.height > 0 && img.bottom <= innerHeight + 1 && img.top >= -1,
        pageNotGrown: after <= before + 1,
    };

    lightbox.hidden = true;
    image.src = '';

    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    return {
        ok: failed.length === 0,
        failed,
        checks,
        pageHeight: { before, after, window: innerHeight },
        lightbox: { position: style.position, zIndex: style.zIndex, width: Math.round(box.width), height: Math.round(box.height) },
        image: { width: Math.round(img.width), height: Math.round(img.height) },
    };
}