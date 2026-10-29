// Mobile nav toggle
const navToggle = document.querySelector('.nav-toggle');
const sidenav = document.querySelector('.sidenav');
if (navToggle && sidenav) {
  navToggle.addEventListener('click', () => {
    const open = sidenav.classList.toggle('open');
    navToggle.classList.toggle('open', open);
    navToggle.setAttribute('aria-expanded', open);
  });
  // Close nav when a link is clicked
  sidenav.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      sidenav.classList.remove('open');
      navToggle.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });
}

// Carousel
const track = document.querySelector('.carousel-track');
if (track) {
  const slides = Array.from(track.querySelectorAll('.carousel-slide'));
  let current = 0;

  function show(index) {
    slides[current].classList.remove('active');
    current = (index + slides.length) % slides.length;
    slides[current].classList.add('active');
  }

  document.querySelector('.carousel-prev')?.addEventListener('click', () => show(current - 1));
  document.querySelector('.carousel-next')?.addEventListener('click', () => show(current + 1));
}

// ZUZU scroll photo reveal
// Photos fade in sequentially as you scroll through the sticky hero section.
// Each photo has a data-reveal threshold (0–1 fraction of total scroll depth).
const zuzuHero = document.getElementById('zuzu-hero');
if (zuzuHero) {
  const photos = Array.from(zuzuHero.querySelectorAll('.zuzu-photo[data-reveal]'));

  function updateZuzuPhotos() {
    const rect = zuzuHero.getBoundingClientRect();
    const scrollable = zuzuHero.offsetHeight - window.innerHeight;
    const progress = Math.max(0, Math.min(1, -rect.top / scrollable));

    photos.forEach(photo => {
      const threshold = parseFloat(photo.dataset.reveal);
      const visible = progress >= threshold;
      // Fade in when threshold reached; all fade out near end of section
      const fadeOut = progress > 0.82;
      if (fadeOut) {
        photo.style.opacity = Math.max(0, 1 - (progress - 0.82) / 0.1);
      } else {
        photo.style.opacity = visible ? Math.min(1, (progress - threshold) / 0.06) : 0;
      }
    });
  }

  window.addEventListener('scroll', updateZuzuPhotos, { passive: true });
  updateZuzuPhotos();
}

// Italic hover on paragraph links (matches Squarespace behavior)
document.querySelectorAll('p a').forEach(a => {
  a.style.transition = 'font-style 0.1s';
});
