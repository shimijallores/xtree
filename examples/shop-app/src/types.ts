// Domain types for the demo shop.

export interface BaseEntity {
  id: string;
  createdAt: Date;
}

export interface Product extends BaseEntity {
  name: string;
  price: number;
}

export interface OrderItem {
  productId: string;
  price: number;
  quantity: number;
}

export type OrderStatus = "pending" | "paid" | "cancelled";

export interface Order {
  id: string;
  items: OrderItem[];
  total: number;
  status: OrderStatus;
}

export interface Cart {
  id: string;
  items: OrderItem[];
}

export interface Discount {
  kind: "percent" | "fixed";
  value: number;
}

export enum Currency {
  PHP = "PHP",
  USD = "USD",
}
