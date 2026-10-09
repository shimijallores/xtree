import type {
  CodeEdge,
  CodeSymbol,
  FileNode,
  FlowStep,
  Graph,
  SymbolField,
  SymbolKind,
  Visibility,
} from "../types";

// Mock data modelled on specs.md section 11 (examples/shop-app).

const ADD = "src/AddToCart.ts";
const PRC = "src/pricing.ts";
const INV = "src/inventory.ts";
const TYP = "src/types.ts";
const ORD = "src/orders.ts";

let line = 1;
function sym(
  file: string,
  qname: string,
  kind: SymbolKind,
  signature: string,
  source: string,
  summary: string,
  extra: {
    parentId?: string;
    visibility?: Visibility;
    fields?: SymbolField[];
  } = {},
): CodeSymbol {
  const lines = source.split("\n").length;
  const s: CodeSymbol = {
    id: `${file}#${qname}`,
    kind,
    name: qname.includes(".") ? qname.split(".").pop()! : qname,
    file,
    range: { start: line, end: line + lines - 1 },
    signature,
    source,
    hash: `sha256-${qname.toLowerCase().replace(/\W/g, "")}`,
    summary,
    ...extra,
  };
  line += lines + 1;
  return s;
}

const symbols: CodeSymbol[] = [
  // ---- AddToCart.ts
  sym(
    ADD,
    "addToCart",
    "function",
    "addToCart(cart: Cart, item: OrderItem): Order",
    `export function addToCart(cart: Cart, item: OrderItem): Order {
  const product = inventory.getProduct(item.productId);
  if (!product) throw new Error("Unknown product");
  const total = calculateOrderTotal([...cart.items, item]);
  reserveOrderStock(item);
  return processOrder({ ...cart, items: [...cart.items, item], total });
}`,
    "Validates the item, prices the cart, reserves stock and creates the order.",
  ),

  // ---- pricing.ts
  sym(
    PRC,
    "calculateOrderTotal",
    "function",
    "calculateOrderTotal(items: OrderItem[], discount?: Discount): number",
    `export function calculateOrderTotal(items: OrderItem[], discount?: Discount): number {
  const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const discounted = discount ? applyDiscount(subtotal, discount) : subtotal;
  return discounted + calculateTax(discounted);
}`,
    "Sums line items, applies an optional discount, then adds tax.",
  ),
  sym(
    PRC,
    "applyDiscount",
    "function",
    "applyDiscount(amount: number, discount: Discount): number",
    `export function applyDiscount(amount: number, discount: Discount): number {
  if (discount.kind === "percent") return amount * (1 - discount.value / 100);
  return Math.max(0, amount - discount.value);
}`,
    "Reduces an amount by a percent or fixed discount, never below zero.",
  ),
  sym(
    PRC,
    "calculateTax",
    "function",
    "calculateTax(amount: number): number",
    `export function calculateTax(amount: number): number {
  return Math.round(amount * TAX_RATE * 100) / 100;
}`,
    "Returns the tax owed on an amount, rounded to cents.",
  ),

  // ---- inventory.ts
  sym(
    INV,
    "Inventory",
    "class",
    "class Inventory implements StockStore",
    `export class Inventory implements StockStore {
  #stock = new Map<string, number>();
  warehouse: string;
  protected lowStockThreshold = 5;

  getProduct(id: string): Product | undefined { ... }
  reserve(productId: string, quantity: number): void { ... }
  release(productId: string, quantity: number): void { ... }
}`,
    "Tracks stock per product and lets callers reserve or release units.",
    {
      fields: [
        { name: "#stock", type: "Map<string, number>", visibility: "private" },
        { name: "warehouse", type: "string", visibility: "public" },
        { name: "lowStockThreshold", type: "number", visibility: "protected" },
      ],
    },
  ),
  sym(
    INV,
    "Inventory.getProduct",
    "method",
    "getProduct(id: string): Product | undefined",
    `getProduct(id: string): Product | undefined {
  return this.#catalog.get(id);
}`,
    "Looks up a product by id and returns undefined when missing.",
    { parentId: `${INV}#Inventory`, visibility: "public" },
  ),
  sym(
    INV,
    "Inventory.reserve",
    "method",
    "reserve(productId: string, quantity: number): void",
    `reserve(productId: string, quantity: number): void {
  const product = this.getProduct(productId);
  const available = this.#stock.get(productId) ?? 0;
  if (!product || available < quantity) throw new Error("Out of stock");
  this.#stock.set(productId, available - quantity);
}`,
    "Removes units from stock, throwing when there is not enough.",
    { parentId: `${INV}#Inventory`, visibility: "public" },
  ),
  sym(
    INV,
    "Inventory.release",
    "method",
    "release(productId: string, quantity: number): void",
    `release(productId: string, quantity: number): void {
  const available = this.#stock.get(productId) ?? 0;
  this.#stock.set(productId, available + quantity);
}`,
    "Returns previously reserved units back to stock.",
    { parentId: `${INV}#Inventory`, visibility: "public" },
  ),
  sym(
    INV,
    "StockStore",
    "interface",
    "interface StockStore",
    `export interface StockStore {
  reserve(productId: string, quantity: number): void;
  release(productId: string, quantity: number): void;
}`,
    "Contract for anything that can reserve and release stock.",
    {
      fields: [
        { name: "reserve", type: "(id, qty) => void", visibility: "public" },
        { name: "release", type: "(id, qty) => void", visibility: "public" },
      ],
    },
  ),

  // ---- types.ts
  sym(
    TYP,
    "BaseEntity",
    "interface",
    "interface BaseEntity",
    `export interface BaseEntity {
  id: string;
  createdAt: Date;
}`,
    "Shared id and creation date for stored entities.",
    {
      fields: [
        { name: "id", type: "string", visibility: "public" },
        { name: "createdAt", type: "Date", visibility: "public" },
      ],
    },
  ),
  sym(
    TYP,
    "Product",
    "interface",
    "interface Product extends BaseEntity",
    `export interface Product extends BaseEntity {
  name: string;
  price: number;
}`,
    "A sellable item with a name and price.",
    {
      fields: [
        { name: "name", type: "string", visibility: "public" },
        { name: "price", type: "number", visibility: "public" },
      ],
    },
  ),
  sym(
    TYP,
    "OrderItem",
    "interface",
    "interface OrderItem",
    `export interface OrderItem {
  productId: string;
  price: number;
  quantity: number;
}`,
    "One product line inside an order.",
    {
      fields: [
        { name: "productId", type: "string", visibility: "public" },
        { name: "price", type: "number", visibility: "public" },
        { name: "quantity", type: "number", visibility: "public" },
      ],
    },
  ),
  sym(
    TYP,
    "Order",
    "interface",
    "interface Order",
    `export interface Order {
  id: string;
  items: OrderItem[];
  total: number;
  status: OrderStatus;
}`,
    "A customer order with its items, total and status.",
    {
      fields: [
        { name: "id", type: "string", visibility: "public" },
        { name: "items", type: "OrderItem[]", visibility: "public" },
        { name: "total", type: "number", visibility: "public" },
        { name: "status", type: "OrderStatus", visibility: "public" },
      ],
    },
  ),
  sym(
    TYP,
    "OrderStatus",
    "type",
    'type OrderStatus = "pending" | "paid" | "cancelled"',
    `export type OrderStatus = "pending" | "paid" | "cancelled";`,
    "The lifecycle states an order can be in.",
    {
      fields: [
        { name: "pending", type: "", visibility: "public" },
        { name: "paid", type: "", visibility: "public" },
        { name: "cancelled", type: "", visibility: "public" },
      ],
    },
  ),
  sym(
    TYP,
    "Discount",
    "interface",
    "interface Discount",
    `export interface Discount {
  kind: "percent" | "fixed";
  value: number;
}`,
    "A percent or fixed-amount price reduction.",
    {
      fields: [
        { name: "kind", type: '"percent" | "fixed"', visibility: "public" },
        { name: "value", type: "number", visibility: "public" },
      ],
    },
  ),

  // ---- orders.ts
  sym(
    ORD,
    "processOrder",
    "function",
    "processOrder(order: Order): Order",
    `export function processOrder(order: Order): Order {
  const total = calculateOrderTotal(order.items);
  logger.info("processing", order.id);
  return { ...order, total, status: "paid" };
}`,
    "Re-prices the order, logs it and marks it as paid.",
  ),
  sym(
    ORD,
    "reserveOrderStock",
    "function",
    "reserveOrderStock(item: OrderItem): void",
    `export function reserveOrderStock(item: OrderItem): void {
  inventory.reserve(item.productId, item.quantity);
}`,
    "Reserves inventory for a single order line.",
  ),
  sym(
    ORD,
    "cancelOrder",
    "function",
    "cancelOrder(order: Order): Order",
    `export function cancelOrder(order: Order): Order {
  for (const item of order.items) inventory.release(item.productId, item.quantity);
  return { ...order, status: "cancelled" };
}`,
    "Puts every line's stock back and marks the order cancelled.",
  ),

  // ---- externals (never guessed edges, only unresolved calls)
  {
    id: "external#logger.info",
    kind: "external",
    name: "logger.info",
    file: "external",
    range: { start: 0, end: 0 },
    signature: "logger.info(...)",
    source: "",
    hash: "external",
  },
  {
    id: "external#Map.get",
    kind: "external",
    name: "Map.get",
    file: "external",
    range: { start: 0, end: 0 },
    signature: "Map.get(...)",
    source: "",
    hash: "external",
  },
];

let eid = 0;
const e = (kind: CodeEdge["kind"], from: string, to: string, order?: number): CodeEdge => ({
  id: `e${++eid}`,
  kind,
  from,
  to,
  order,
});

const id = (file: string, q: string) => `${file}#${q}`;

const edges: CodeEdge[] = [
  // calls (numbered in call order inside the caller)
  e("calls", id(ADD, "addToCart"), id(INV, "Inventory.getProduct"), 1),
  e("calls", id(ADD, "addToCart"), id(PRC, "calculateOrderTotal"), 2),
  e("calls", id(ADD, "addToCart"), id(ORD, "reserveOrderStock"), 3),
  e("calls", id(ADD, "addToCart"), id(ORD, "processOrder"), 4),
  e("calls", id(PRC, "calculateOrderTotal"), id(PRC, "applyDiscount"), 1),
  e("calls", id(PRC, "calculateOrderTotal"), id(PRC, "calculateTax"), 2),
  e("calls", id(ORD, "processOrder"), id(PRC, "calculateOrderTotal"), 1),
  e("calls", id(ORD, "processOrder"), "external#logger.info", 2),
  e("calls", id(ORD, "reserveOrderStock"), id(INV, "Inventory.reserve"), 1),
  e("calls", id(ORD, "cancelOrder"), id(INV, "Inventory.release"), 1),
  e("calls", id(INV, "Inventory.reserve"), id(INV, "Inventory.getProduct"), 1),
  e("calls", id(INV, "Inventory.getProduct"), "external#Map.get", 1),

  // contains
  e("contains", id(INV, "Inventory"), id(INV, "Inventory.getProduct")),
  e("contains", id(INV, "Inventory"), id(INV, "Inventory.reserve")),
  e("contains", id(INV, "Inventory"), id(INV, "Inventory.release")),

  // uses-type
  e("uses-type", id(ADD, "addToCart"), id(TYP, "OrderItem")),
  e("uses-type", id(ADD, "addToCart"), id(TYP, "Order")),
  e("uses-type", id(PRC, "calculateOrderTotal"), id(TYP, "OrderItem")),
  e("uses-type", id(PRC, "calculateOrderTotal"), id(TYP, "Discount")),
  e("uses-type", id(PRC, "applyDiscount"), id(TYP, "Discount")),
  e("uses-type", id(ORD, "processOrder"), id(TYP, "Order")),
  e("uses-type", id(ORD, "cancelOrder"), id(TYP, "Order")),
  e("uses-type", id(ORD, "reserveOrderStock"), id(TYP, "OrderItem")),
  e("uses-type", id(INV, "Inventory.getProduct"), id(TYP, "Product")),
  e("uses-type", id(TYP, "Order"), id(TYP, "OrderItem")),
  e("uses-type", id(TYP, "Order"), id(TYP, "OrderStatus")),

  // inheritance
  e("extends", id(TYP, "Product"), id(TYP, "BaseEntity")),
  e("implements", id(INV, "Inventory"), id(INV, "StockStore")),
];

export const shopGraph: Graph = {
  entry: ADD,
  symbols,
  edges,
};

export const fileTree: FileNode[] = [
  {
    name: "src",
    path: "src",
    type: "dir",
    children: [
      { name: "AddToCart.ts", path: ADD, type: "file" },
      { name: "inventory.ts", path: INV, type: "file" },
      { name: "orders.ts", path: ORD, type: "file" },
      { name: "pricing.ts", path: PRC, type: "file" },
      { name: "types.ts", path: TYP, type: "file" },
    ],
  },
  { name: "package.json", path: "package.json", type: "file" },
];

export const flowSteps: FlowStep[] = [
  {
    step: 1,
    symbolId: id(ADD, "addToCart"),
    text: "addToCart receives the cart and the new item and starts the checkout flow.",
  },
  {
    step: 2,
    symbolId: id(INV, "Inventory.getProduct"),
    text: "It looks the product up in the inventory and throws if it does not exist.",
  },
  {
    step: 3,
    symbolId: id(PRC, "calculateOrderTotal"),
    text: "It prices the cart by summing lines, applying a discount and adding tax.",
  },
  {
    step: 4,
    symbolId: id(PRC, "applyDiscount"),
    text: "applyDiscount lowers the subtotal by a percent or a fixed amount.",
  },
  {
    step: 5,
    symbolId: id(PRC, "calculateTax"),
    text: "calculateTax adds tax on the discounted amount, rounded to cents.",
  },
  {
    step: 6,
    symbolId: id(ORD, "reserveOrderStock"),
    text: "reserveOrderStock asks the inventory to hold the requested quantity.",
  },
  {
    step: 7,
    symbolId: id(INV, "Inventory.reserve"),
    text: "Inventory.reserve removes the units, or throws 'Out of stock' if there are not enough.",
  },
  {
    step: 8,
    symbolId: id(ORD, "processOrder"),
    text: "processOrder re-prices, logs, and returns the order marked as paid.",
  },
];
