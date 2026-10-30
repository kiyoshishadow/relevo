import { z } from 'zod';
import { CASE_STATUSES } from '../domain/states.js';
import { isValidDateOnly } from '../domain/coverage.js';
import { parseMoneyToCents } from '../domain/money.js';
import { ApiError } from '../lib/http.js';

const trimmed = z.string().trim();
const email = trimmed.min(3).max(254).email().transform((value) => value.toLowerCase());
const phone = trimmed.min(5, 'Teléfono demasiado corto').max(40);
const dateOnly = z
  .string()
  .refine((value) => isValidDateOnly(value), 'Use una fecha ISO válida YYYY-MM-DD');
const id = z.coerce.number().int().positive();
const money = z.union([z.string(), z.number()]).transform((value, ctx) => {
  try {
    return parseMoneyToCents(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error.message });
    return z.NEVER;
  }
});
const positiveMoney = z.union([z.string(), z.number()]).transform((value, ctx) => {
  try {
    return parseMoneyToCents(value, { allowZero: false });
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error.message });
    return z.NEVER;
  }
});
const stringList = z.array(trimmed.min(1).max(200)).max(50);
const newPassword = z
  .string()
  .min(10)
  .max(128)
  .refine((value) => new TextEncoder().encode(value).length <= 72, 'La contraseña no puede superar 72 bytes UTF-8');

export const loginSchema = z
  .object({
    email,
    password: z.string().min(1, 'La contraseña es obligatoria').max(128),
  })
  .strict();

const clientShape = {
  full_name: trimmed.min(2).max(160),
  document_id: trimmed.min(1).max(60).nullable().optional(),
  phone,
  email,
  address: trimmed.max(300).nullable().optional(),
  active: z.boolean().optional(),
};
export const clientCreateSchema = z.object(clientShape).strict();
export const clientPatchSchema = z
  .object(clientShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Envíe al menos un campo para actualizar');

const imeis = z
  .array(trimmed.regex(/^\d{14,16}$/, 'El IMEI debe tener entre 14 y 16 dígitos'))
  .max(2, 'Se admiten como máximo dos IMEI (doble SIM)')
  .refine((values) => new Set(values).size === values.length, 'Los IMEI no pueden repetirse')
  .optional();

const terminalShape = {
  client_id: id,
  brand: trimmed.min(1).max(80),
  model: trimmed.min(1).max(120),
  imeis,
  purchase_date: dateOnly,
  accessories: trimmed.max(1000).optional(),
  initial_condition: trimmed.min(2).max(1000),
  coverage_id: id.nullable().optional(),
};
export const terminalCreateSchema = z.object(terminalShape).strict();

const coverageShape = {
  brand: trimmed.min(1).max(80).nullable().optional(),
  name: trimmed.min(2).max(120),
  plan: trimmed.min(1).max(80),
  months: z.coerce.number().int().min(1).max(120),
  exclusions: stringList.optional(),
  replacement_policy: z.enum(['new', 'continue']),
  active: z.boolean().optional(),
};
export const coverageCreateSchema = z.object(coverageShape).strict();
export const coveragePatchSchema = z
  .object(coverageShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Envíe al menos un campo para actualizar');

export const caseCreateSchema = z
  .object({
    client_id: id,
    terminal_id: id,
    reported_problem: trimmed.min(3).max(2000),
    technician_id: id.nullable().optional(),
  })
  .strict();

export const casePatchSchema = z
  .object({ technician_id: id.nullable() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Envíe technician_id');

export const diagnosisSchema = z
  .object({
    diagnosis: trimmed.min(3).max(5000),
    problem_type: trimmed.min(2).max(120),
    excluded_reason: trimmed.max(500).nullable().optional(),
    coverage_override: z.boolean().optional(),
    override_reason: trimmed.max(500).nullable().optional(),
  })
  .strict();

export const transitionSchema = z
  .object({
    status: z.enum(CASE_STATUSES),
    note: trimmed.max(2000).nullable().optional(),
  })
  .strict();

export const actionSchema = z
  .object({
    description: trimmed.min(3).max(2000),
    parts: stringList.optional(),
  })
  .strict();

export const quoteCreateSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            description: trimmed.min(1).max(300),
            quantity: z.coerce.number().int().min(1).max(1000),
            unit_price: money,
          })
          .strict(),
      )
      .min(1)
      .max(100),
    note: trimmed.max(2000).nullable().optional(),
  })
  .strict();

export const quoteDecisionSchema = z.object({ accepted: z.boolean() }).strict();

export const paymentSchema = z
  .object({
    amount: positiveMoney,
    method: z.enum(['cash', 'card', 'transfer', 'other']),
    reference: trimmed.max(120).nullable().optional(),
    idempotency_key: trimmed.min(1).max(128),
  })
  .strict();

export const loanDeviceCreateSchema = z
  .object({
    asset_tag: trimmed.min(1).max(60),
    brand: trimmed.min(1).max(80),
    model: trimmed.min(1).max(120),
    condition: trimmed.max(500).optional(),
    notes: trimmed.max(1000).nullable().optional(),
  })
  .strict();

export const caseLoanSchema = z
  .object({
    loan_device_id: id,
    condition_out: trimmed.min(2).max(500),
  })
  .strict();

export const loanReturnSchema = z.object({ condition_in: trimmed.min(2).max(500) }).strict();

export const replacementSchema = z
  .object({
    terminal_id: id,
    policy: z.enum(['new', 'continue']),
  })
  .strict();

export const trackSchema = z
  .object({
    case_number: trimmed.min(3).max(40),
    token: z.string().min(20).max(200),
  })
  .strict();

export const userCreateSchema = z
  .object({
    email,
    full_name: trimmed.min(2).max(160),
    role: z.enum(['admin', 'reception', 'technician']),
    password: newPassword,
    active: z.boolean().optional(),
  })
  .strict();

export const userPatchSchema = z
  .object({
    email,
    full_name: trimmed.min(2).max(160),
    role: z.enum(['admin', 'reception', 'technician']),
    password: newPassword,
    active: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Envíe al menos un campo para actualizar');

export function validateBody(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      return next(validationError(result.error));
    }
    req.body = result.data;
    return next();
  };
}

export function validateQuery(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) return next(validationError(result.error));
    req.validatedQuery = result.data;
    return next();
  };
}

function validationError(error) {
  return new ApiError(
    400,
    'VALIDATION_ERROR',
    'Datos inválidos',
    error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
      code: issue.code,
    })),
  );
}
