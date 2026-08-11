import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  CreateShipmentInput,
  Currency,
  FulfillmentOrder,
  GoodsReceipt,
  OrderExpense,
} from '../lib/types';

const card = {
  border: '1px solid #dbe3ee',
  borderRadius: 10,
  padding: 16,
  marginBottom: 14,
  background: '#fff',
};

function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : '操作失败';
}

function shouldRetainOperation(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return [408, 425, 429].includes(error.status) || error.status >= 500;
}

type ShipmentOperation = {
  orderId: string;
  input: CreateShipmentInput;
};

type TransitOperation = Parameters<typeof apiClient.addLogisticsEvent>[1];

type RunResult = { ok: true } | { ok: false; error: unknown };

export function FulfillmentPage() {
  const { hasPermission } = useAuth();
  const [orders, setOrders] = useState<Array<{ id: string; order_number: string; status: string }>>(
    [],
  );
  const [orderId, setOrderId] = useState('');
  const [flow, setFlow] = useState<FulfillmentOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiptBatch, setReceiptBatch] = useState('');
  const [purchaseOrderId, setPurchaseOrderId] = useState('');
  const [purchaseItemId, setPurchaseItemId] = useState('');
  const [receiptQuantity, setReceiptQuantity] = useState('');
  const [finalReceipt, setFinalReceipt] = useState(false);
  const [qcFile, setQcFile] = useState<File | null>(null);
  const [qcDrafts, setQcDrafts] = useState<
    Record<string, { accepted_quantity: string; rejected_quantity: string }>
  >({});
  const [receiptReasons, setReceiptReasons] = useState<Record<string, string>>({});
  const [shipmentBatch, setShipmentBatch] = useState('');
  const [shipmentItemId, setShipmentItemId] = useState('');
  const [shipmentQuantity, setShipmentQuantity] = useState('');
  const [shipmentPackageNo, setShipmentPackageNo] = useState('');
  const [shipmentGrossWeight, setShipmentGrossWeight] = useState('');
  const [shipmentNetWeight, setShipmentNetWeight] = useState('');
  const [shipmentVolume, setShipmentVolume] = useState('');
  const [shipmentPackageQuantities, setShipmentPackageQuantities] = useState<
    Record<string, string>
  >({});
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [expenseShipmentId, setExpenseShipmentId] = useState('');
  const [expenseType, setExpenseType] = useState<OrderExpense['expense_type']>('freight');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseCurrency, setExpenseCurrency] = useState<Currency>('RMB');
  const [expenseFxRate, setExpenseFxRate] = useState('');
  const [expenseFxSource, setExpenseFxSource] = useState('');
  const [expenseFxTime, setExpenseFxTime] = useState('');
  const [completionFxRate, setCompletionFxRate] = useState('');
  const [completionFxSource, setCompletionFxSource] = useState('');
  const [completionFxTime, setCompletionFxTime] = useState('');
  const [deliveryFiles, setDeliveryFiles] = useState<Record<string, File | null>>({});
  const [deliveryRecipients, setDeliveryRecipients] = useState<Record<string, string>>({});
  const [deliveryNotes, setDeliveryNotes] = useState<Record<string, string>>({});
  const [deliveryExceptions, setDeliveryExceptions] = useState<Record<string, string>>({});
  const [paymentReceiptIds, setPaymentReceiptIds] = useState<Record<string, string>>({});
  const shipmentOperationRef = useRef<ShipmentOperation | null>(null);
  const transitOperationRef = useRef<Record<string, TransitOperation>>({});

  const purchaseOrder = flow?.purchase_orders.find((row) => row.id === purchaseOrderId) ?? null;
  const shippableItems = useMemo(
    () => flow?.items.filter((item) => Number(item.available_quantity) > 0) ?? [],
    [flow],
  );
  const selectedPackingPackage = useMemo(
    () =>
      flow?.packing_list_source?.packages.find(
        (sourcePackage) => sourcePackage.package_no === shipmentPackageNo,
      ) ?? null,
    [flow, shipmentPackageNo],
  );

  async function loadOrder(id: string) {
    if (!id) {
      setFlow(null);
      return;
    }
    const next = await apiClient.getFulfillmentOrder(id);
    setFlow(next);
    setPurchaseOrderId((current) => current || next.purchase_orders[0]?.id || '');
    const firstPackage = next.packing_list_source?.packages[0];
    setShipmentPackageNo(firstPackage?.package_no ?? '');
    setShipmentNetWeight(firstPackage?.net_weight_kg ?? '');
    setShipmentVolume(firstPackage?.volume_cbm ?? '');
    setShipmentPackageQuantities(
      Object.fromEntries(
        (firstPackage?.items ?? []).map((item) => [item.sales_order_item_id, item.quantity]),
      ),
    );
    setShipmentItemId(firstPackage?.items[0]?.sales_order_item_id ?? next.items[0]?.id ?? '');
    setShipmentQuantity(firstPackage?.items[0]?.quantity ?? '');
    setQcDrafts((current) => {
      const copy = { ...current };
      for (const receipt of next.goods_receipts) {
        for (const item of receipt.items) {
          copy[item.id] ??= {
            accepted_quantity: item.received_quantity,
            rejected_quantity: '0',
          };
        }
      }
      return copy;
    });
  }

  async function loadInitial() {
    const listed = await apiClient.listSalesOrders({ pageSize: 100 });
    const relevant = listed.data.filter((order) =>
      ['approved', 'procurement', 'fulfillment', 'delivered'].includes(order.status),
    );
    setOrders(relevant);
    const nextId = orderId || relevant[0]?.id || '';
    setOrderId(nextId);
    await loadOrder(nextId);
  }

  useEffect(() => {
    void loadInitial().catch((caught) => setError(errorMessage(caught)));
  }, []);

  useEffect(() => {
    setPurchaseItemId(purchaseOrder?.items[0]?.id ?? '');
  }, [purchaseOrderId, flow]);

  async function run(action: () => Promise<unknown>): Promise<RunResult> {
    setBusy(true);
    setError(null);
    try {
      await action();
      try {
        await loadOrder(orderId);
      } catch (caught) {
        setError(`操作已完成，但刷新失败：${errorMessage(caught)}`);
      }
      return { ok: true };
    } catch (caught) {
      setError(errorMessage(caught));
      return { ok: false, error: caught };
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    if (!flow) return;
    await run(() => apiClient.updateFulfillmentSettings(flow.settings));
  }

  async function createReceipt(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const uploaded = qcFile ? await apiClient.uploadFile(qcFile, 'qc_photo') : null;
      await apiClient.createGoodsReceipt(purchaseOrderId, {
        batch_number: receiptBatch,
        is_final_batch: finalReceipt,
        file_ids: uploaded ? [uploaded.id] : undefined,
        items: [{ purchase_order_item_id: purchaseItemId, received_quantity: receiptQuantity }],
      });
      setReceiptBatch('');
      setReceiptQuantity('');
      setQcFile(null);
    });
  }

  async function inspect(receipt: GoodsReceipt) {
    await run(() =>
      apiClient.inspectGoodsReceipt(
        receipt.id,
        receipt.items.map((item) => ({ item_id: item.id, ...qcDrafts[item.id] })),
      ),
    );
  }

  async function createShipment(event: FormEvent) {
    event.preventDefault();
    const operation =
      shipmentOperationRef.current ??
      ({
        orderId,
        input: {
          idempotency_key: `shipment:${orderId}:${crypto.randomUUID()}`,
          batch_number: shipmentBatch,
          carrier,
          tracking_number: trackingNumber,
          packing_list_document_set_id: flow?.packing_list_source?.document_set_id,
          packing_list_version: flow?.packing_list_source?.version,
          boxes: [
            {
              package_no: shipmentPackageNo,
              gross_weight_kg: shipmentGrossWeight,
              net_weight_kg: shipmentNetWeight,
              volume_cbm: shipmentVolume,
              items: selectedPackingPackage?.items.map((item) => ({
                sales_order_item_id: item.sales_order_item_id,
                quantity: shipmentPackageQuantities[item.sales_order_item_id] ?? item.quantity,
              })) ?? [{ sales_order_item_id: shipmentItemId, quantity: shipmentQuantity }],
            },
          ],
        },
      } satisfies ShipmentOperation);
    shipmentOperationRef.current = operation;
    const result = await run(() => apiClient.createShipment(operation.orderId, operation.input));
    if (result.ok) {
      resetShipmentForm();
    } else if (!shouldRetainOperation(result.error)) {
      shipmentOperationRef.current = null;
    }
  }

  function resetShipmentForm() {
    shipmentOperationRef.current = null;
    const firstPackage = flow?.packing_list_source?.packages[0];
    setShipmentBatch('');
    setShipmentPackageNo(firstPackage?.package_no ?? '');
    setShipmentItemId(firstPackage?.items[0]?.sales_order_item_id ?? flow?.items[0]?.id ?? '');
    setShipmentQuantity(firstPackage?.items[0]?.quantity ?? '');
    setShipmentGrossWeight('');
    setShipmentNetWeight(firstPackage?.net_weight_kg ?? '');
    setShipmentVolume(firstPackage?.volume_cbm ?? '');
    setShipmentPackageQuantities(
      Object.fromEntries(
        (firstPackage?.items ?? []).map((item) => [item.sales_order_item_id, item.quantity]),
      ),
    );
    setTrackingNumber('');
  }

  function selectPackingPackage(packageNo: string) {
    const sourcePackage = flow?.packing_list_source?.packages.find(
      (candidate) => candidate.package_no === packageNo,
    );
    setShipmentPackageNo(packageNo);
    setShipmentNetWeight(sourcePackage?.net_weight_kg ?? '');
    setShipmentVolume(sourcePackage?.volume_cbm ?? '');
    setShipmentGrossWeight('');
    if (sourcePackage?.items.length === 1) {
      setShipmentItemId(sourcePackage.items[0].sales_order_item_id);
      setShipmentQuantity(sourcePackage.items[0].quantity);
    }
    setShipmentPackageQuantities(
      Object.fromEntries(
        (sourcePackage?.items ?? []).map((item) => [item.sales_order_item_id, item.quantity]),
      ),
    );
  }

  async function recordExpense(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await apiClient.recordOrderExpense(orderId, {
        shipment_id: expenseShipmentId || undefined,
        expense_type: expenseType,
        amount: expenseAmount,
        currency: expenseCurrency,
        fx_rate_to_rmb: expenseCurrency === 'RMB' ? undefined : expenseFxRate || undefined,
        fx_source: expenseCurrency === 'RMB' ? undefined : expenseFxSource || undefined,
        fx_captured_at: expenseCurrency === 'RMB' ? undefined : expenseFxTime || undefined,
      });
      setExpenseAmount('');
    });
  }

  async function completeExpense(expenseId: string) {
    await run(() =>
      apiClient.completeExpenseFx(expenseId, {
        fx_rate_to_rmb: completionFxRate,
        fx_source: completionFxSource,
        fx_captured_at: completionFxTime,
      }),
    );
  }

  async function recordTransit(shipmentId: string) {
    const operation =
      transitOperationRef.current[shipmentId] ??
      ({
        idempotency_key: `shipment-transit:${shipmentId}:${crypto.randomUUID()}`,
        event_type: 'in_transit',
        description: '人工更新运输中',
        occurred_at: new Date().toISOString(),
      } satisfies TransitOperation);
    transitOperationRef.current[shipmentId] = operation;
    const result = await run(() => apiClient.addLogisticsEvent(shipmentId, operation));
    if (result.ok || !shouldRetainOperation(result.error)) {
      delete transitOperationRef.current[shipmentId];
    }
  }

  async function deliver(shipmentId: string) {
    const file = deliveryFiles[shipmentId];
    if (!file) {
      setError('签收必须上传凭证');
      return;
    }
    const receivedBy = deliveryRecipients[shipmentId]?.trim();
    if (!receivedBy) {
      setError('签收必须记录实际签收人');
      return;
    }
    await run(async () => {
      const uploaded = await apiClient.uploadFile(file, 'delivery_proof');
      await apiClient.deliverShipment(shipmentId, {
        delivered_at: new Date().toISOString(),
        received_by: receivedBy,
        attachment_file_ids: [uploaded.id],
        note: deliveryNotes[shipmentId]?.trim() || undefined,
        exception_note: deliveryExceptions[shipmentId]?.trim() || undefined,
      });
    });
  }

  return (
    <section style={{ maxWidth: 1180 }}>
      <h1 style={{ fontSize: 24, marginTop: 0 }}>到货、QC、装箱发货与签收</h1>
      <p style={{ color: '#64748b' }}>
        箱号、数量、毛净重和体积形成不可变发货快照；签收和收款里程碑独立推进。
      </p>
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}
      <div style={card}>
        <label>
          履约订单{' '}
          <select
            aria-label="履约订单"
            value={orderId}
            onChange={(event) => {
              shipmentOperationRef.current = null;
              transitOperationRef.current = {};
              setOrderId(event.target.value);
              void loadOrder(event.target.value).catch((caught) => setError(errorMessage(caught)));
            }}
          >
            {orders.map((order) => (
              <option key={order.id} value={order.id}>
                {order.order_number} · {order.status}
              </option>
            ))}
          </select>
        </label>
        {flow && <strong style={{ marginLeft: 16 }}>聚合状态：{flow.aggregate_status}</strong>}
      </div>

      {!flow && <p>当前没有进入采购或履约阶段的订单。</p>}
      {flow && (
        <>
          {hasPermission('tenant_settings:update') && (
            <div style={card}>
              <h2 style={{ marginTop: 0, fontSize: 18 }}>到货确认规则</h2>
              <label>
                <input
                  type="checkbox"
                  checked={flow.settings.require_sales_receipt_confirmation}
                  onChange={(event) =>
                    setFlow({
                      ...flow,
                      settings: {
                        require_sales_receipt_confirmation: event.target.checked,
                      },
                    })
                  }
                />{' '}
                QC 通过后必须由订单业务员二次确认
              </label>{' '}
              <button disabled={busy} onClick={() => void saveSettings()}>
                保存确认规则
              </button>
            </div>
          )}

          <div style={card}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>可发数量</h2>
            <table style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>订单行</th>
                  <th>订单数量</th>
                  <th>QC 接受</th>
                  <th>已发</th>
                  <th>已签收</th>
                  <th>当前可发</th>
                </tr>
              </thead>
              <tbody>
                {flow.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.description}</td>
                    <td>{item.quantity}</td>
                    <td>{item.accepted_quantity}</td>
                    <td>{item.shipped_quantity}</td>
                    <td>{item.delivered_quantity}</td>
                    <td>{item.available_quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasPermission('goods_receipts:manage') && (
            <form style={card} onSubmit={createReceipt}>
              <h2 style={{ marginTop: 0, fontSize: 18 }}>记录分批到货</h2>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select
                  aria-label="采购单"
                  value={purchaseOrderId}
                  onChange={(event) => setPurchaseOrderId(event.target.value)}
                >
                  {flow.purchase_orders.map((order) => (
                    <option key={order.id} value={order.id}>
                      {order.order_number}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="到货采购行"
                  value={purchaseItemId}
                  onChange={(event) => setPurchaseItemId(event.target.value)}
                >
                  {purchaseOrder?.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.description} · {item.quantity}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="到货批次"
                  required
                  placeholder="批次号"
                  value={receiptBatch}
                  onChange={(event) => setReceiptBatch(event.target.value)}
                />
                <input
                  aria-label="到货数量"
                  required
                  placeholder="数量"
                  value={receiptQuantity}
                  onChange={(event) => setReceiptQuantity(event.target.value)}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={finalReceipt}
                    onChange={(event) => setFinalReceipt(event.target.checked)}
                  />{' '}
                  最终批次
                </label>
                <input
                  aria-label="QC 照片"
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,.pdf"
                  onChange={(event) => setQcFile(event.target.files?.[0] ?? null)}
                />
                <button disabled={busy || !purchaseItemId}>记录到货</button>
              </div>
            </form>
          )}

          <div style={card}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>到货与 QC</h2>
            {flow.goods_receipts.map((receipt) => (
              <div key={receipt.id} style={{ borderTop: '1px solid #e2e8f0', padding: '10px 0' }}>
                <strong>{receipt.batch_number}</strong> · {receipt.status} · QC{' '}
                {receipt.qc_result ?? '待检'}
                {receipt.items.map((item) => (
                  <div key={item.id} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <span>到货 {item.received_quantity}</span>
                    {receipt.status === 'pending' && hasPermission('goods_receipts:manage') && (
                      <>
                        <input
                          aria-label={`QC 接受数量 ${receipt.batch_number}`}
                          value={qcDrafts[item.id]?.accepted_quantity ?? item.received_quantity}
                          onChange={(event) =>
                            setQcDrafts((current) => ({
                              ...current,
                              [item.id]: {
                                accepted_quantity: event.target.value,
                                rejected_quantity: current[item.id]?.rejected_quantity ?? '0',
                              },
                            }))
                          }
                        />
                        <input
                          aria-label={`QC 拒收数量 ${receipt.batch_number}`}
                          value={qcDrafts[item.id]?.rejected_quantity ?? '0'}
                          onChange={(event) =>
                            setQcDrafts((current) => ({
                              ...current,
                              [item.id]: {
                                accepted_quantity:
                                  current[item.id]?.accepted_quantity ?? item.received_quantity,
                                rejected_quantity: event.target.value,
                              },
                            }))
                          }
                        />
                      </>
                    )}
                  </div>
                ))}
                {receipt.status === 'pending' && hasPermission('goods_receipts:manage') && (
                  <button disabled={busy} onClick={() => void inspect(receipt)}>
                    提交 QC
                  </button>
                )}
                {receipt.status === 'inspected' && hasPermission('goods_receipts:confirm') && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      aria-label={`到货确认原因 ${receipt.batch_number}`}
                      placeholder="拒绝时必填原因"
                      value={receiptReasons[receipt.id] ?? ''}
                      onChange={(event) =>
                        setReceiptReasons((current) => ({
                          ...current,
                          [receipt.id]: event.target.value,
                        }))
                      }
                    />{' '}
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(() => apiClient.confirmGoodsReceipt(receipt.id, 'accepted'))
                      }
                    >
                      业务确认
                    </button>{' '}
                    <button
                      disabled={busy || !receiptReasons[receipt.id]?.trim()}
                      onClick={() =>
                        void run(() =>
                          apiClient.confirmGoodsReceipt(
                            receipt.id,
                            'rejected',
                            receiptReasons[receipt.id],
                          ),
                        )
                      }
                    >
                      业务拒绝
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {hasPermission('shipments:manage') && (
            <form style={card} onSubmit={createShipment}>
              <h2 style={{ marginTop: 0, fontSize: 18 }}>创建发货批次</h2>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {selectedPackingPackage ? (
                  <div style={{ display: 'grid', gap: 6, minWidth: 260 }}>
                    {selectedPackingPackage.items.map((packageItem, index) => {
                      const orderItem = flow.items.find(
                        (item) => item.id === packageItem.sales_order_item_id,
                      );
                      const label =
                        index === 0
                          ? '发货数量'
                          : `装箱数量 ${orderItem?.description ?? packageItem.sales_order_item_id}`;
                      return (
                        <label key={packageItem.sales_order_item_id}>
                          {orderItem?.description ?? packageItem.sales_order_item_id} · 可发{' '}
                          {orderItem?.available_quantity ?? '-'}
                          <input
                            aria-label={label}
                            required
                            value={shipmentPackageQuantities[packageItem.sales_order_item_id] ?? ''}
                            onChange={(event) => {
                              const quantity = event.target.value;
                              setShipmentPackageQuantities((current) => ({
                                ...current,
                                [packageItem.sales_order_item_id]: quantity,
                              }));
                              if (index === 0) setShipmentQuantity(quantity);
                            }}
                          />
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <select
                    aria-label="发货订单行"
                    value={shipmentItemId}
                    onChange={(event) => setShipmentItemId(event.target.value)}
                  >
                    {shippableItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.description} · 可发 {item.available_quantity}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  aria-label="发货批次"
                  required
                  value={shipmentBatch}
                  onChange={(event) => setShipmentBatch(event.target.value)}
                />
                {!selectedPackingPackage && (
                  <input
                    aria-label="发货数量"
                    required
                    value={shipmentQuantity}
                    onChange={(event) => setShipmentQuantity(event.target.value)}
                  />
                )}
                {flow.packing_list_source?.packages.length ? (
                  <select
                    aria-label="装箱单箱号"
                    required
                    value={shipmentPackageNo}
                    onChange={(event) => selectPackingPackage(event.target.value)}
                  >
                    {flow.packing_list_source.packages.map((sourcePackage, index) => (
                      <option
                        key={`${sourcePackage.package_no}-${index}`}
                        value={sourcePackage.package_no}
                      >
                        {sourcePackage.package_no} · 净重 {sourcePackage.net_weight_kg ?? '-'} kg ·{' '}
                        {sourcePackage.volume_cbm ?? '-'} CBM
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label="箱号"
                    required
                    value={shipmentPackageNo}
                    onChange={(event) => setShipmentPackageNo(event.target.value)}
                  />
                )}
                <input
                  aria-label="毛重 kg"
                  required
                  value={shipmentGrossWeight}
                  onChange={(event) => setShipmentGrossWeight(event.target.value)}
                />
                <input
                  aria-label="净重 kg"
                  required
                  value={shipmentNetWeight}
                  onChange={(event) => setShipmentNetWeight(event.target.value)}
                />
                <input
                  aria-label="体积 CBM"
                  required
                  value={shipmentVolume}
                  onChange={(event) => setShipmentVolume(event.target.value)}
                />
                <input
                  aria-label="承运方"
                  required
                  value={carrier}
                  onChange={(event) => setCarrier(event.target.value)}
                />
                <input
                  aria-label="物流单号"
                  required
                  value={trackingNumber}
                  onChange={(event) => setTrackingNumber(event.target.value)}
                />
                <button disabled={busy || !shipmentItemId}>创建发货</button>
                <button type="button" disabled={busy} onClick={resetShipmentForm}>
                  重置发货表单
                </button>
              </div>
            </form>
          )}

          {hasPermission('order_expenses:record') && (
            <form style={card} onSubmit={recordExpense}>
              <h2 style={{ marginTop: 0, fontSize: 18 }}>记录多币种费用</h2>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select
                  aria-label="费用关联发货"
                  value={expenseShipmentId}
                  onChange={(event) => setExpenseShipmentId(event.target.value)}
                >
                  <option value="">订单级费用</option>
                  {flow.shipments.map((shipment) => (
                    <option key={shipment.id} value={shipment.id}>
                      {shipment.batch_number}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="费用类型"
                  value={expenseType}
                  onChange={(event) =>
                    setExpenseType(event.target.value as OrderExpense['expense_type'])
                  }
                >
                  <option value="freight">运费</option>
                  <option value="insurance">保险</option>
                  <option value="customs">关务</option>
                  <option value="other">其他</option>
                </select>
                <input
                  aria-label="费用金额"
                  required
                  value={expenseAmount}
                  onChange={(event) => setExpenseAmount(event.target.value)}
                />
                <select
                  aria-label="费用币种"
                  value={expenseCurrency}
                  onChange={(event) => setExpenseCurrency(event.target.value as Currency)}
                >
                  {(['RMB', 'USD', 'HKD', 'EUR'] as Currency[]).map((currency) => (
                    <option key={currency}>{currency}</option>
                  ))}
                </select>
                {expenseCurrency !== 'RMB' && (
                  <>
                    <input
                      aria-label="折人民币汇率"
                      placeholder="留空将生成待补汇率异常"
                      value={expenseFxRate}
                      onChange={(event) => setExpenseFxRate(event.target.value)}
                    />
                    <input
                      aria-label="汇率来源"
                      value={expenseFxSource}
                      onChange={(event) => setExpenseFxSource(event.target.value)}
                    />
                    <input
                      aria-label="汇率时间"
                      type="datetime-local"
                      value={expenseFxTime}
                      onChange={(event) => setExpenseFxTime(event.target.value)}
                    />
                  </>
                )}
                <button disabled={busy}>冻结费用</button>
              </div>
            </form>
          )}

          <div style={card}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>费用快照</h2>
            {flow.expenses.map((expense) => (
              <div key={expense.id} style={{ borderTop: '1px solid #e2e8f0', padding: 8 }}>
                {expense.expense_type} · {expense.currency} {expense.amount} ·{' '}
                {expense.status === 'complete'
                  ? `RMB ${expense.amount_rmb}（${expense.fx_source} @ ${expense.fx_rate_to_rmb}）`
                  : '待补汇率'}
                {expense.status === 'pending_fx' && hasPermission('order_expenses:record') && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input
                      aria-label="补录汇率"
                      value={completionFxRate}
                      onChange={(event) => setCompletionFxRate(event.target.value)}
                    />
                    <input
                      aria-label="补录汇率来源"
                      value={completionFxSource}
                      onChange={(event) => setCompletionFxSource(event.target.value)}
                    />
                    <input
                      aria-label="补录汇率时间"
                      type="datetime-local"
                      value={completionFxTime}
                      onChange={(event) => setCompletionFxTime(event.target.value)}
                    />
                    <button disabled={busy} onClick={() => void completeExpense(expense.id)}>
                      冻结补录汇率
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={card}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>发货、物流与签收</h2>
            {flow.shipments.map((shipment) => (
              <div key={shipment.id} style={{ borderTop: '1px solid #e2e8f0', padding: '10px 0' }}>
                <strong>{shipment.batch_number}</strong> · {shipment.carrier} ·{' '}
                {shipment.tracking_number} · {shipment.status}
                {shipment.status === 'draft' && hasPermission('shipments:manage') && (
                  <button
                    disabled={busy}
                    onClick={() => void run(() => apiClient.dispatchShipment(shipment.id))}
                  >
                    确认发货
                  </button>
                )}
                {shipment.boxes.map((box) => (
                  <div key={box.id} style={{ marginTop: 6, color: '#475569' }}>
                    箱号 {box.package_no} · 毛重 {box.gross_weight_kg} kg · 净重 {box.net_weight_kg}{' '}
                    kg · {box.volume_cbm} CBM
                  </div>
                ))}
                {shipment.status === 'dispatched' && hasPermission('shipments:manage') && (
                  <div style={{ marginTop: 8 }}>
                    <button disabled={busy} onClick={() => void recordTransit(shipment.id)}>
                      记录运输中
                    </button>
                  </div>
                )}
                {shipment.status === 'in_transit' && hasPermission('shipments:manage') && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      aria-label={`签收人 ${shipment.batch_number}`}
                      placeholder="实际签收人"
                      value={deliveryRecipients[shipment.id] ?? ''}
                      onChange={(event) =>
                        setDeliveryRecipients((current) => ({
                          ...current,
                          [shipment.id]: event.target.value,
                        }))
                      }
                    />
                    <input
                      aria-label={`签收备注 ${shipment.batch_number}`}
                      placeholder="签收备注"
                      value={deliveryNotes[shipment.id] ?? ''}
                      onChange={(event) =>
                        setDeliveryNotes((current) => ({
                          ...current,
                          [shipment.id]: event.target.value,
                        }))
                      }
                    />
                    <input
                      aria-label={`签收异常 ${shipment.batch_number}`}
                      placeholder="异常备注（可选）"
                      value={deliveryExceptions[shipment.id] ?? ''}
                      onChange={(event) =>
                        setDeliveryExceptions((current) => ({
                          ...current,
                          [shipment.id]: event.target.value,
                        }))
                      }
                    />
                    <input
                      aria-label={`签收凭证 ${shipment.batch_number}`}
                      type="file"
                      accept=".png,.jpg,.jpeg,.webp,.pdf"
                      onChange={(event) =>
                        setDeliveryFiles((current) => ({
                          ...current,
                          [shipment.id]: event.target.files?.[0] ?? null,
                        }))
                      }
                    />
                    <button disabled={busy} onClick={() => void deliver(shipment.id)}>
                      确认签收
                    </button>
                  </div>
                )}
                {shipment.status === 'delivered' && (
                  <div style={{ marginTop: 8 }}>
                    签收人：{shipment.received_by_name} · 附件 {shipment.delivery_files.length} 个
                    {shipment.delivery_exception_note
                      ? ` · 异常：${shipment.delivery_exception_note}`
                      : ''}
                  </div>
                )}
                {shipment.status !== 'draft' && hasPermission('shipments:manage') && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      aria-label={`关联收款流水 ${shipment.batch_number}`}
                      placeholder="客户收款流水 UUID"
                      value={paymentReceiptIds[shipment.id] ?? ''}
                      onChange={(event) =>
                        setPaymentReceiptIds((current) => ({
                          ...current,
                          [shipment.id]: event.target.value,
                        }))
                      }
                    />{' '}
                    <button
                      disabled={busy || !paymentReceiptIds[shipment.id]}
                      onClick={() =>
                        void run(() =>
                          apiClient.linkShipmentReceipt(
                            shipment.id,
                            paymentReceiptIds[shipment.id],
                          ),
                        )
                      }
                    >
                      关联独立收款里程碑
                    </button>
                  </div>
                )}
                <ul>
                  {shipment.logistics_events.map((event) => (
                    <li key={event.id}>
                      {event.event_type} · {new Date(event.occurred_at).toLocaleString()}
                    </li>
                  ))}
                </ul>
                {shipment.receipts.map((receipt) => (
                  <div key={receipt.id}>
                    收款里程碑：{receipt.currency} {receipt.amount} · {receipt.status}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
