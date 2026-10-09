import { inventory } from "./inventory";
import { logger } from "./logger";
import { calculateOrderTotal } from "./pricing";
import type { Order, OrderItem } from "./types";

/** Re-prices the order, logs it and marks it as paid. */
export function processOrder(order: Order): Order {
  const total = calculateOrderTotal(order.items);
  logger.info("processing", order.id);
  return { ...order, total, status: "paid" };
}

/** Reserves inventory for one order line. */
export function reserveOrderStock(item: OrderItem): void {
  inventory.reserve(item.productId, item.quantity);
}

/** Puts every line's stock back and marks the order cancelled. */
export function cancelOrder(order: Order): Order {
  for (const item of order.items) inventory.release(item.productId, item.quantity);
  logger.info("cancelled", order.id);
  return { ...order, status: "cancelled" };
}
