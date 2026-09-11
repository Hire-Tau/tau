/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __TAU_APP_URL__: string
declare const __TAU_APP_BASE_PATH__: string
/** Build id shared by the page bundle and the service worker; undefined outside vite builds (tests). */
declare const __TAU_SW_CACHE_VERSION__: string | undefined
/** True only while the Vite development server exposes its local backend controls. */
declare const __TAU_DEV_BACKEND_BAR__: boolean | undefined
