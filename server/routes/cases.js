import express from 'express';
import { CASE_STATUSES } from '../domain/states.js';
import { ApiError, asyncHandler, clientIp, ok, parseId, parseIdQuery, parsePagination, searchTerm } from '../lib/http.js';
import {
  actionSchema,
  caseCreateSchema,
  caseLoanSchema,
  casePatchSchema,
  diagnosisSchema,
  loanReturnSchema,
  paymentSchema,
  quoteCreateSchema,
  quoteDecisionSchema,
  replacementSchema,
  transitionSchema,
  validateBody,
} from '../validation/schemas.js';
import {
  addCaseAction,
  addPayment,
  assignTechnician,
  createCase,
  createQuote,
  createReplacement,
  decideQuote,
  diagnoseCase,
  getCaseDetail,
  listCases,
  transitionCase,
} from '../services/cases.js';
import { assignLoan, returnLoan } from '../services/loans.js';
import { requireRole } from '../middleware/session.js';

const router = express.Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, pageSize, offset } = parsePagination(req.query);
    const status = searchTerm(req.query.status);
    if (status && !CASE_STATUSES.includes(status)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'status inválido');
    }
    const result = await listCases(req.user, {
      q: searchTerm(req.query.q),
      status: status || undefined,
      client_id: parseIdQuery(req.query.client_id, 'client_id'),
      technician_id: parseIdQuery(req.query.technician_id, 'technician_id'),
      page,
      pageSize,
      offset,
    });
    return ok(res, result.data, 200, result.meta);
  }),
);

router.post(
  '/',
  validateBody(caseCreateSchema),
  asyncHandler(async (req, res) => {
    if (!['admin', 'reception'].includes(req.user.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'El caso lo registra recepción o administración');
    }
    const created = await createCase(req.user, req.body, { ip: clientIp(req) });
    return ok(res, created, 201);
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const detail = await getCaseDetail(req.user, parseId(req.params.id));
    return ok(res, detail);
  }),
);

router.patch(
  '/:id',
  requireRole('admin', 'reception'),
  validateBody(casePatchSchema),
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id);
    const result = await assignTechnician(req.user, id, req.body, {
      ip: clientIp(req),
    });
    return ok(res, result);
  }),
);

router.post(
  '/:id/diagnosis',
  validateBody(diagnosisSchema),
  asyncHandler(async (req, res) => {
    const result = await diagnoseCase(req.user, parseId(req.params.id), req.body, {
      ip: clientIp(req),
    });
    return ok(res, result);
  }),
);

router.post(
  '/:id/transition',
  validateBody(transitionSchema),
  asyncHandler(async (req, res) => {
    const result = await transitionCase(req.user, parseId(req.params.id), req.body, {
      ip: clientIp(req),
    });
    return ok(res, result);
  }),
);

router.post(
  '/:id/actions',
  validateBody(actionSchema),
  asyncHandler(async (req, res) => {
    const result = await addCaseAction(req.user, parseId(req.params.id), req.body, {
      ip: clientIp(req),
    });
    return ok(res, result, 201);
  }),
);

router.post(
  '/:id/quote',
  validateBody(quoteCreateSchema),
  asyncHandler(async (req, res) => {
    const result = await createQuote(req.user, parseId(req.params.id), req.body, {
      ip: clientIp(req),
    });
    return ok(res, result, 201);
  }),
);

router.post(
  '/:id/quote/decision',
  validateBody(quoteDecisionSchema),
  asyncHandler(async (req, res) => {
    const result = await decideQuote(req.user, parseId(req.params.id), req.body, {
      ip: clientIp(req),
    });
    return ok(res, result);
  }),
);

router.post(
  '/:id/payments',
  validateBody(paymentSchema),
  asyncHandler(async (req, res) => {
    const result = await addPayment(req.user, parseId(req.params.id), req.body, {
      ip: clientIp(req),
    });
    return ok(res, result, result.replayed ? 200 : 201);
  }),
);

router.post(
  '/:id/loan',
  validateBody(caseLoanSchema),
  asyncHandler(async (req, res) => {
    const result = await assignLoan(req.user, parseId(req.params.id), req.body, {
      ip: clientIp(req),
    });
    return ok(res, result, 201);
  }),
);

router.post(
  '/:id/loan/return',
  validateBody(loanReturnSchema),
  asyncHandler(async (req, res) => {
    const result = await returnLoan(req.user, parseId(req.params.id), req.body, {
      ip: clientIp(req),
    });
    return ok(res, result);
  }),
);

router.post(
  '/:id/replacement',
  validateBody(replacementSchema),
  asyncHandler(async (req, res) => {
    const result = await createReplacement(req.user, parseId(req.params.id), req.body, {
      ip: clientIp(req),
    });
    return ok(res, result, 201);
  }),
);

export default router;
