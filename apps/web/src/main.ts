import "./styles/reset.css";
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router";
import { installZoomLock } from "./lib/zoom-lock";
import "./style.scss";
import "./styles/ui.css";
import { initializePwa } from "./lib/pwa";

const disposePwa = initializePwa();
import.meta.hot?.dispose(disposePwa);

const removeZoomLock = installZoomLock();
import.meta.hot?.dispose(removeZoomLock);

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.mount("#app");
