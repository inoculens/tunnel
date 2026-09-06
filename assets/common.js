/**
 * FRONTFACER Tunnel - Common JavaScript logic
 * Unified navigation and utility functions
 */

// Mobile Menu Logic
function toggleMobileMenu(open) {
  const drawer = document.getElementById('mobileDrawer');
  const overlay = document.getElementById('drawerOverlay');
  if (open) {
    drawer.classList.add('active');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
  } else {
    drawer.classList.remove('active');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
  }
}
