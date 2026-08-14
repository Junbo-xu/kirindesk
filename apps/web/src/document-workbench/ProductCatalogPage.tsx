import { FormEvent, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  Currency,
  ProductFieldRecord,
  ProductInput,
  ProductRecord,
  SupplierResponse,
  TradeDocumentType,
} from '../lib/types';

const DOCUMENT_TYPES: Array<{ value: TradeDocumentType; label: string }> = [
  { value: 'quote', label: 'QT' },
  { value: 'pi', label: 'PI' },
  { value: 'sc', label: 'SC' },
  { value: 'ci', label: 'CI' },
  { value: 'pl', label: 'PL' },
];

const EMPTY_PRODUCT: ProductInput = {
  sku: '',
  name: '',
  unit: 'pcs',
  default_currency: 'USD',
  default_unit_price: '0',
  custom_values: {},
};

export function ProductCatalogPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('products:manage');
  const canManageFields = hasPermission('product_fields:manage');
  const canSeeCost = hasPermission('document_financials:view');
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierResponse[]>([]);
  const [fields, setFields] = useState<ProductFieldRecord[]>([]);
  const [product, setProduct] = useState<ProductInput>(EMPTY_PRODUCT);
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const [fieldKey, setFieldKey] = useState('');
  const [fieldLabel, setFieldLabel] = useState('');
  const [fieldType, setFieldType] = useState<'text' | 'number' | 'boolean' | 'date'>('text');
  const [fieldDocuments, setFieldDocuments] = useState<TradeDocumentType[]>([
    'quote',
    'pi',
    'sc',
    'ci',
    'pl',
  ]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [productResult, fieldResult, supplierResult] = await Promise.all([
        apiClient.listProducts({ pageSize: 100 }),
        apiClient.listProductFields(),
        canSeeCost
          ? apiClient.listSuppliers({ pageSize: 100, status: 'active' })
          : Promise.resolve({ data: [], page: 1, pageSize: 100, total: 0 }),
      ]);
      setProducts(productResult.data);
      setFields([...fieldResult.system, ...fieldResult.custom]);
      setSuppliers(supplierResult.data);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '加载产品库失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function createProduct(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const thumbnailFile = thumbnail
        ? await apiClient.uploadFile(thumbnail, 'product-thumbnail')
        : null;
      await apiClient.createProduct({
        ...product,
        sku: product.sku.trim(),
        name: product.name.trim(),
        unit: product.unit.trim(),
        ...(product.description?.trim() ? { description: product.description.trim() } : {}),
        ...(product.cost_unit_price ? { cost_unit_price: product.cost_unit_price } : {}),
        ...(product.supplier_id ? { supplier_id: product.supplier_id } : {}),
        ...(product.purchase_currency ? { purchase_currency: product.purchase_currency } : {}),
        ...(product.purchase_unit_price
          ? { purchase_unit_price: product.purchase_unit_price }
          : {}),
        ...(product.weight_kg ? { weight_kg: product.weight_kg } : {}),
        ...(product.volume_cbm ? { volume_cbm: product.volume_cbm } : {}),
        ...(thumbnailFile ? { thumbnail_file_id: thumbnailFile.id } : {}),
        custom_values: Object.fromEntries(
          Object.entries(product.custom_values ?? {}).filter(
            ([, value]) => value !== '' && value !== undefined,
          ),
        ),
      });
      setProduct(EMPTY_PRODUCT);
      setThumbnail(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '创建产品失败');
    } finally {
      setSaving(false);
    }
  }

  async function toggleProduct(record: ProductRecord) {
    setError(null);
    try {
      await apiClient.updateProduct(record.id, { active: !record.active });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '更新产品失败');
    }
  }

  async function createField(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiClient.createProductField({
        field_key: fieldKey.trim(),
        label: fieldLabel.trim(),
        data_type: fieldType,
        sort_order:
          fields
            .filter((field) => !field.system)
            .reduce((highest, field) => Math.max(highest, field.sort_order), -1) + 1,
        document_types: fieldDocuments,
      });
      setFieldKey('');
      setFieldLabel('');
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '创建字段失败');
    } finally {
      setSaving(false);
    }
  }

  async function toggleField(field: ProductFieldRecord) {
    if (!field.id) return;
    setError(null);
    try {
      await apiClient.updateProductField(field.id, { active: !field.active });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '更新字段失败');
    }
  }

  function updateFieldDraft(id: string, patch: Partial<ProductFieldRecord>) {
    setFields((current) =>
      current.map((field) => (field.id === id ? { ...field, ...patch } : field)),
    );
  }

  async function saveField(field: ProductFieldRecord) {
    if (!field.id || field.document_types.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await apiClient.updateProductField(field.id, {
        sort_order: field.sort_order,
        document_types: field.document_types,
      });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '保存字段配置失败');
    } finally {
      setSaving(false);
    }
  }

  function setProductCustomValue(field: ProductFieldRecord, value: unknown) {
    setProduct({
      ...product,
      custom_values: { ...product.custom_values, [field.field_key]: value },
    });
  }

  async function deleteField(field: ProductFieldRecord) {
    if (!field.id || !window.confirm(`删除自定义字段“${field.label}”？历史单据快照不会改变。`))
      return;
    setError(null);
    try {
      await apiClient.deleteProductField(field.id);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '删除字段失败');
    }
  }

  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 24 }}>产品库与单据字段</h1>
        <p style={{ color: '#64748b' }}>
          系统字段固定保留；自定义字段可控制状态、顺序及五类单据显示。
        </p>
      </header>
      {error && (
        <div role="alert" style={{ color: '#b42318', background: '#fef3f2', padding: 12 }}>
          {error}
        </div>
      )}
      {canManage && (
        <form
          onSubmit={createProduct}
          style={{
            background: 'white',
            border: '1px solid #e2e8f0',
            borderRadius: 10,
            padding: 18,
          }}
        >
          <h2 style={{ marginTop: 0, fontSize: 18 }}>新增产品</h2>
          <div
            style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}
          >
            <label>
              SKU
              <input
                required
                value={product.sku}
                onChange={(event) => setProduct({ ...product, sku: event.target.value })}
                style={{ width: '100%' }}
              />
            </label>
            <label>
              名称
              <input
                required
                value={product.name}
                onChange={(event) => setProduct({ ...product, name: event.target.value })}
                style={{ width: '100%' }}
              />
            </label>
            <label>
              单位
              <input
                required
                value={product.unit}
                onChange={(event) => setProduct({ ...product, unit: event.target.value })}
                style={{ width: '100%' }}
              />
            </label>
            <label>
              币种
              <input
                required
                pattern="[A-Z]{3}"
                value={product.default_currency}
                onChange={(event) =>
                  setProduct({ ...product, default_currency: event.target.value.toUpperCase() })
                }
                style={{ width: '100%' }}
              />
            </label>
            <label>
              默认售价
              <input
                required
                value={product.default_unit_price}
                onChange={(event) =>
                  setProduct({ ...product, default_unit_price: event.target.value })
                }
                style={{ width: '100%' }}
              />
            </label>
            {canSeeCost && (
              <>
                <label>
                  成本价
                  <input
                    value={product.cost_unit_price ?? ''}
                    onChange={(event) =>
                      setProduct({ ...product, cost_unit_price: event.target.value })
                    }
                    style={{ width: '100%' }}
                  />
                </label>
                <label>
                  默认供应商
                  <select
                    value={product.supplier_id ?? ''}
                    onChange={(event) =>
                      setProduct({ ...product, supplier_id: event.target.value || undefined })
                    }
                    style={{ width: '100%' }}
                  >
                    <option value="">未配置</option>
                    {suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.company_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  采购币种
                  <select
                    value={product.purchase_currency ?? ''}
                    onChange={(event) =>
                      setProduct({
                        ...product,
                        purchase_currency: (event.target.value as Currency) || undefined,
                      })
                    }
                    style={{ width: '100%' }}
                  >
                    <option value="">未配置</option>
                    {(['RMB', 'USD', 'HKD', 'EUR'] as Currency[]).map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  采购单价
                  <input
                    value={product.purchase_unit_price ?? ''}
                    onChange={(event) =>
                      setProduct({ ...product, purchase_unit_price: event.target.value })
                    }
                    style={{ width: '100%' }}
                  />
                </label>
              </>
            )}
            <label>
              单件重量 kg
              <input
                value={product.weight_kg ?? ''}
                onChange={(event) => setProduct({ ...product, weight_kg: event.target.value })}
                style={{ width: '100%' }}
              />
            </label>
            <label>
              单件体积 CBM
              <input
                value={product.volume_cbm ?? ''}
                onChange={(event) => setProduct({ ...product, volume_cbm: event.target.value })}
                style={{ width: '100%' }}
              />
            </label>
            <label>
              产品缩略图
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => setThumbnail(event.target.files?.[0] ?? null)}
              />
            </label>
          </div>
          <label style={{ display: 'block', marginTop: 12 }}>
            描述
            <textarea
              value={product.description ?? ''}
              onChange={(event) => setProduct({ ...product, description: event.target.value })}
              rows={2}
              style={{ width: '100%' }}
            />
          </label>
          {fields.some((field) => !field.system && field.active) && (
            <fieldset
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                gap: 12,
                marginTop: 12,
              }}
            >
              <legend>自定义字段</legend>
              {fields
                .filter((field) => !field.system && field.active)
                .map((field) => (
                  <label key={field.id}>
                    {field.label}
                    {field.data_type === 'boolean' ? (
                      <input
                        type="checkbox"
                        checked={Boolean(product.custom_values?.[field.field_key])}
                        onChange={(event) => setProductCustomValue(field, event.target.checked)}
                      />
                    ) : (
                      <input
                        type={
                          field.data_type === 'date'
                            ? 'date'
                            : field.data_type === 'number'
                              ? 'number'
                              : 'text'
                        }
                        step={field.data_type === 'number' ? 'any' : undefined}
                        value={String(product.custom_values?.[field.field_key] ?? '')}
                        onChange={(event) => setProductCustomValue(field, event.target.value)}
                        style={{ width: '100%' }}
                      />
                    )}
                  </label>
                ))}
            </fieldset>
          )}
          <button type="submit" disabled={saving} style={{ marginTop: 12 }}>
            {saving ? '保存中…' : '保存产品'}
          </button>
        </form>
      )}
      <section
        style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: 10, padding: 18 }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18 }}>产品</h2>
        {loading ? (
          <p>加载中…</p>
        ) : products.length === 0 ? (
          <p>暂无产品</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>SKU</th>
                <th style={{ textAlign: 'left' }}>名称</th>
                <th>售价</th>
                {canSeeCost && <th>成本</th>}
                {canSeeCost && <th>采购映射</th>}
                <th>重量 / 体积</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {products.map((record) => (
                <tr key={record.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                  <td style={{ padding: '10px 4px' }}>{record.sku}</td>
                  <td>{record.name}</td>
                  <td style={{ textAlign: 'center' }}>
                    {record.default_currency} {record.default_unit_price}
                  </td>
                  {canSeeCost && (
                    <td style={{ textAlign: 'center' }}>{record.cost_unit_price ?? '-'}</td>
                  )}
                  {canSeeCost && (
                    <td style={{ textAlign: 'center' }}>
                      {record.supplier_id
                        ? `${suppliers.find((supplier) => supplier.id === record.supplier_id)?.company_name ?? record.supplier_id} / ${record.purchase_currency} ${record.purchase_unit_price}`
                        : '-'}
                    </td>
                  )}
                  <td style={{ textAlign: 'center' }}>
                    {record.weight_kg ?? '-'} kg / {record.volume_cbm ?? '-'} CBM
                  </td>
                  <td style={{ textAlign: 'center' }}>{record.active ? '启用' : '停用'}</td>
                  <td>
                    {canManage && (
                      <button type="button" onClick={() => void toggleProduct(record)}>
                        {record.active ? '停用' : '启用'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section
        style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: 10, padding: 18 }}
      >
        <h2 style={{ marginTop: 0, fontSize: 18 }}>字段配置</h2>
        {canManageFields && (
          <form
            onSubmit={createField}
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'end',
              flexWrap: 'wrap',
              marginBottom: 16,
            }}
          >
            <label>
              字段键
              <input
                required
                pattern="[a-z][a-z0-9_]{1,63}"
                value={fieldKey}
                onChange={(event) => setFieldKey(event.target.value)}
              />
            </label>
            <label>
              显示名
              <input
                required
                value={fieldLabel}
                onChange={(event) => setFieldLabel(event.target.value)}
              />
            </label>
            <label>
              类型
              <select
                value={fieldType}
                onChange={(event) => setFieldType(event.target.value as typeof fieldType)}
              >
                <option value="text">文本</option>
                <option value="number">数字</option>
                <option value="boolean">是/否</option>
                <option value="date">日期</option>
              </select>
            </label>
            <fieldset style={{ display: 'flex', gap: 8, border: 0, padding: 0 }}>
              <legend>显示于</legend>
              {DOCUMENT_TYPES.map((type) => (
                <label key={type.value}>
                  <input
                    type="checkbox"
                    checked={fieldDocuments.includes(type.value)}
                    onChange={(event) =>
                      setFieldDocuments(
                        event.target.checked
                          ? [...fieldDocuments, type.value]
                          : fieldDocuments.filter((value) => value !== type.value),
                      )
                    }
                  />
                  {type.label}
                </label>
              ))}
            </fieldset>
            <button type="submit" disabled={saving || fieldDocuments.length === 0}>
              新增字段
            </button>
          </form>
        )}
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>字段</th>
              <th>类型</th>
              <th>显示单据</th>
              <th>顺序</th>
              <th>状态</th>
              <th>性质</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr
                key={`${field.system ? 'system' : 'custom'}-${field.field_key}`}
                style={{ borderTop: '1px solid #e2e8f0' }}
              >
                <td style={{ padding: '10px 4px' }}>
                  {field.label}
                  <div style={{ color: '#64748b', fontSize: 12 }}>{field.field_key}</div>
                </td>
                <td style={{ textAlign: 'center' }}>{field.data_type}</td>
                <td style={{ textAlign: 'center' }}>
                  {canManageFields && !field.system ? (
                    <span style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                      {DOCUMENT_TYPES.map((type) => (
                        <label key={type.value}>
                          <input
                            type="checkbox"
                            checked={field.document_types.includes(type.value)}
                            onChange={(event) =>
                              updateFieldDraft(field.id!, {
                                document_types: event.target.checked
                                  ? [...field.document_types, type.value]
                                  : field.document_types.filter((value) => value !== type.value),
                              })
                            }
                          />
                          {type.label}
                        </label>
                      ))}
                    </span>
                  ) : (
                    field.document_types.map((value) => value.toUpperCase()).join(' / ')
                  )}
                </td>
                <td style={{ textAlign: 'center' }}>
                  {canManageFields && !field.system ? (
                    <input
                      type="number"
                      min={0}
                      value={field.sort_order}
                      onChange={(event) =>
                        updateFieldDraft(field.id!, { sort_order: Number(event.target.value) })
                      }
                      style={{ width: 64 }}
                    />
                  ) : (
                    field.sort_order
                  )}
                </td>
                <td style={{ textAlign: 'center' }}>{field.active ? '启用' : '停用'}</td>
                <td style={{ textAlign: 'center' }}>
                  {field.system ? '系统字段（不可删）' : '自定义'}
                </td>
                <td>
                  {canManageFields && !field.system && (
                    <span style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        disabled={saving || field.document_types.length === 0}
                        onClick={() => void saveField(field)}
                      >
                        保存配置
                      </button>
                      <button type="button" onClick={() => void toggleField(field)}>
                        {field.active ? '停用' : '启用'}
                      </button>
                      <button type="button" onClick={() => void deleteField(field)}>
                        删除
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
