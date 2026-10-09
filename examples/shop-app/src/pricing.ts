import type { Discount, OrderItem } from "./types";

export const TAX_RATE = 0.12;

/** Sums the line items, applies an optional discount, then adds tax. */
export function calculateOrderTotal(items: OrderItem[], discount?: Discount): number {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const discounted = discount ? applyDiscount(subtotal, discount) : subtotal;
  return discounted + calculateTax(discounted);
}

/** Reduces an amount by a percent or fixed discount, never below zero. */
export function applyDiscount(amount: number, discount: Discount): number {
  if (discount.kind === "percent") return amount * (1 - discount.value / 100);
  return Math.max(0, amount - discount.value);
}

/** Tax owed on an amount, rounded to cents. */
export function calculateTax(amount: number): number {
  return Math.round(amount * TAX_RATE * 100) / 100;
}
