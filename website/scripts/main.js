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

// Italic hover on paragraph links (matches Squarespace behavior)
document.querySelectorAll('p a').forEach(a => {
  a.style.transition = 'font-style 0.1s';
});
