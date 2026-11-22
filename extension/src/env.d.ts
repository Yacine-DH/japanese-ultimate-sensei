/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SENSEI_BUILD_COMMIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
