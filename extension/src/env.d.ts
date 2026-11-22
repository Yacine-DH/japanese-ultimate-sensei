/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SENSEI_BUILD_COMMIT?: string;
  readonly VITE_SENSEI_EXT_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
