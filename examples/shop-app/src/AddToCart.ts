import { inventory } from "./inventory";
import { processOrder, reserveOrderStock } from "./orders";
import { calculateOrderTotal } from "./pricing";
import type { Cart, Order, OrderItem } from "./types";

/** Entry point of the checkout flow: validates, prices, reserves stock and creates the order. */
export function addToCart(cart: Cart, item: OrderItem): Order {
  const product = inventory.getProduct(item.productId);
  if (!product) throw new Error("Unknown product");
  const items = [...cart.items, item];
  const total = calculateOrderTotal(items);
  reserveOrderStock(item);
  return processOrder({ id: cart.id, items, total, status: "pending" });
}
