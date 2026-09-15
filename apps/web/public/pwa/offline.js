/* global document, window */
document.getElementById("retry").addEventListener("click", () => {
  if (window.location.pathname === "/pwa/offline.html") window.location.assign("/login");
  else window.location.reload();
});
