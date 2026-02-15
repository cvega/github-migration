// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    interface Error {
      message: string;
      code?: string;
    }
    interface Locals {
      authEnabled: boolean;
    }
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
