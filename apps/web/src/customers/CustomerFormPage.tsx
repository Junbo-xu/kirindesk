import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import {
  ApiError,
  CreateCustomerInput,
  CustomerStatus,
  UpdateCustomerInput,
} from '../lib/types';

const STATUS_OPTIONS: { value: CustomerStatus; label: string }[] = [
  { value: 'active', label: '启用' },
  { value: 'inactive', label: '停用' },
];

// Trims a free-text field and returns undefined when empty, so optional fields
// are omitted from the request rather than sent as blank strings.
function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function CustomerFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const [companyName, setCompanyName] = useState('');
  const [contactName, setContactName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState<CustomerStatus>('active');
  const [notes, setNotes] = useState('');

  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);
  const [companyNameError, setCompanyNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setLoading(true);
    setError(null);
    apiClient
      .getCustomer(id)
      .then((c) => {
        if (!active) return;
        setCompanyName(c.company_name);
        setContactName(c.contact_name ?? '');
        setEmail(c.email ?? '');
        setPhone(c.phone ?? '');
        setCountry(c.country ?? '');
        setSource(c.source ?? '');
        setStatus(c.status);
      })
      .catch((err) => {
        if (!active) return;
        const s = err instanceof ApiError ? err.status : 0;
        if (s === 404) setError('客户不存在或已被删除');
        else if (s === 403) setError('没有权限执行该操作');
        else setError(err instanceof ApiError ? err.message : '加载客户失败，请稍后重试');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  function mapError(err: unknown) {
    const status = err instanceof ApiError ? err.status : 0;
    if (status === 400) {
      setError(err instanceof ApiError ? err.message : '提交数据有误');
    } else if (status === 403) {
      setError('没有权限执行该操作');
    } else if (status === 404) {
      setError('客户不存在或已被删除');
    } else {
      setError(err instanceof ApiError ? err.message : '操作失败，请稍后重试');
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setCompanyNameError(null);

    if (companyName.trim() === '') {
      setCompanyNameError('公司名不能为空');
      return;
    }

    setSubmitting(true);
    try {
      if (isEdit && id) {
        const body: UpdateCustomerInput = {
          company_name: companyName.trim(),
          contact_name: optional(contactName),
          email: optional(email),
          phone: optional(phone),
          country: optional(country),
          source: optional(source),
          status,
          notes: optional(notes),
        };
        await apiClient.updateCustomer(id, body);
      } else {
        const body: CreateCustomerInput = {
          company_name: companyName.trim(),
          status,
        };
        const contact = optional(contactName);
        if (contact) body.contact_name = contact;
        const mail = optional(email);
        if (mail) body.email = mail;
        const tel = optional(phone);
        if (tel) body.phone = tel;
        const ctry = optional(country);
        if (ctry) body.country = ctry;
        const src = optional(source);
        if (src) body.source = src;
        const note = optional(notes);
        if (note) body.notes = note;
        await apiClient.createCustomer(body);
      }
      navigate('/customers');
    } catch (err) {
      mapError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const labelStyle: CSSProperties = { display: 'block', marginTop: 12 };

  if (loading) {
    return <p style={{ fontFamily: 'system-ui' }}>加载中…</p>;
  }

  return (
    <div style={{ maxWidth: 480, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 20 }}>{isEdit ? '编辑客户' : '新建客户'}</h1>
      <form onSubmit={onSubmit}>
        <label style={labelStyle}>
          公司名
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            required
            maxLength={200}
            style={{ width: '100%' }}
          />
        </label>
        {companyNameError && <p style={{ color: 'crimson', margin: '4px 0' }}>{companyNameError}</p>}
        <label style={labelStyle}>
          联系人（选填）
          <input
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            maxLength={100}
            style={{ width: '100%' }}
          />
        </label>
        <label style={labelStyle}>
          邮箱（选填）
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={255}
            style={{ width: '100%' }}
          />
        </label>
        <label style={labelStyle}>
          电话（选填）
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={50}
            style={{ width: '100%' }}
          />
        </label>
        <label style={labelStyle}>
          国家（选填）
          <input
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            maxLength={100}
            style={{ width: '100%' }}
          />
        </label>
        <label style={labelStyle}>
          来源（选填）
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            maxLength={50}
            style={{ width: '100%' }}
          />
        </label>
        <label style={labelStyle}>
          状态
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as CustomerStatus)}
            style={{ width: '100%' }}
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          备注（选填）
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={5000}
            rows={4}
            style={{ width: '100%' }}
          />
        </label>
        {error && <p style={{ color: 'crimson', marginTop: 12 }}>{error}</p>}
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button type="submit" disabled={submitting}>
            {submitting ? '提交中…' : isEdit ? '保存' : '创建'}
          </button>
          <button type="button" onClick={() => navigate('/customers')}>取消</button>
        </div>
      </form>
    </div>
  );
}
