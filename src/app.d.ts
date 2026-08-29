declare global {
  namespace App {
    interface Error {
      message: string;
      code?: string;
    }

    interface Locals {
      authEnabled: boolean;
    }
  }
}

export {};
