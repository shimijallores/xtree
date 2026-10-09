import type { Product } from "./types";

/** Anything that can hold and release stock. */
export interface StockStore {
  reserve(productId: string, quantity: number): void;
  release(productId: string, quantity: number): void;
}

export class Inventory implements StockStore {
  #stock = new Map<string, number>();
  #catalog = new Map<string, Product>();
  warehouse: string;
  protected lowStockThreshold = 5;

  constructor(warehouse: string) {
    this.warehouse = warehouse;
  }

  addProduct(product: Product, quantity: number): void {
    this.#catalog.set(product.id, product);
    this.#stock.set(product.id, (this.#stock.get(product.id) ?? 0) + quantity);
  }

  getProduct(id: string): Product | undefined {
    return this.#catalog.get(id);
  }

  reserve(productId: string, quantity: number): void {
    const product = this.getProduct(productId);
    const available = this.#stock.get(productId) ?? 0;
    if (!product || available < quantity) throw new Error("Out of stock");
    this.#stock.set(productId, available - quantity);
    this.#warnIfLow(productId);
  }

  release(productId: string, quantity: number): void {
    const available = this.#stock.get(productId) ?? 0;
    this.#stock.set(productId, available + quantity);
  }

  #warnIfLow(productId: string): void {
    const left = this.#stock.get(productId) ?? 0;
    if (left < this.lowStockThreshold) console.warn(`Low stock for ${productId}: ${left}`);
  }
}

export const inventory = new Inventory("main");
