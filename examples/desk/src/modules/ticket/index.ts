import { motty } from "@mottyjs/core";
import { filed } from "./fill";

export const ticket = motty({ name: "ticket" }).handle(({ prompt }) => filed(prompt));
