import { createApi } from "@convex-dev/better-auth";
import { options } from "../../node_modules/@convex-dev/better-auth/dist/auth-options.js";
import schema from "./schema";

export const {
  create,
  findOne,
  findMany,
  updateOne,
  updateMany,
  deleteOne,
  deleteMany,
} = createApi(schema, () => options);
