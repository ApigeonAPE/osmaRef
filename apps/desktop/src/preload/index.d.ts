import type { DesktopApi } from '@osmaref/contracts';

declare global {
  interface Window {
    osmaRef: DesktopApi;
  }
}

export {};