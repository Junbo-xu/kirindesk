import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient } from '../lib/api-client';
import { ApiError, PublicTradeDocument } from '../lib/types';

const TITLES = {
  zh: {
    customer: '客户',
    amount: '金额',
    download: '下载 PDF',
    confirm: '确认单据',
    confirmed: '已确认',
    missing: '链接无效或已作废',
  },
  en: {
    customer: 'Customer',
    amount: 'Amount',
    download: 'Download PDF',
    confirm: 'Confirm document',
    confirmed: 'Confirmed',
    missing: 'This link is invalid or revoked',
  },
  ru: {
    customer: 'Клиент',
    amount: 'Сумма',
    download: 'Скачать PDF',
    confirm: 'Подтвердить документ',
    confirmed: 'Подтверждено',
    missing: 'Ссылка недействительна или отозвана',
  },
  es: {
    customer: 'Cliente',
    amount: 'Importe',
    download: 'Descargar PDF',
    confirm: 'Confirmar documento',
    confirmed: 'Confirmado',
    missing: 'El enlace no es válido o fue revocado',
  },
  de: {
    customer: 'Kunde',
    amount: 'Betrag',
    download: 'PDF herunterladen',
    confirm: 'Dokument bestätigen',
    confirmed: 'Bestätigt',
    missing: 'Dieser Link ist ungültig oder widerrufen',
  },
  ar: {
    customer: 'العميل',
    amount: 'المبلغ',
    download: 'تنزيل PDF',
    confirm: 'تأكيد المستند',
    confirmed: 'تم التأكيد',
    missing: 'الرابط غير صالح أو تم إلغاؤه',
  },
} as const;

export function PublicTrackingPage() {
  const { token = '' } = useParams();
  const [data, setData] = useState<PublicTradeDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiClient
      .openPublicDocument(token)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof ApiError ? caught.message : 'Document unavailable');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [token]);

  async function confirm() {
    if (!data) return;
    setConfirming(true);
    setError(null);
    try {
      const result = await apiClient.confirmPublicDocument(token);
      setData({ ...data, confirmed_at: result.confirmed_at });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Confirmation failed');
    } finally {
      setConfirming(false);
    }
  }

  const language = data?.document.language ?? 'en';
  const labels = TITLES[language];
  const rtl = language === 'ar';

  if (loading) return <main style={{ fontFamily: 'system-ui', padding: 40 }}>Loading…</main>;
  if (!data)
    return (
      <main style={{ fontFamily: 'system-ui', padding: 40 }}>
        <h1>{labels.missing}</h1>
        {error && <p>{error}</p>}
      </main>
    );

  return (
    <main
      dir={rtl ? 'rtl' : 'ltr'}
      style={{
        fontFamily: 'system-ui',
        minHeight: '100vh',
        background: '#f8fafc',
        padding: '48px 20px',
      }}
    >
      <article
        style={{
          maxWidth: 760,
          margin: '0 auto',
          background: 'white',
          borderRadius: 16,
          borderTop: `6px solid ${data.document.theme_color}`,
          padding: 32,
          boxShadow: '0 12px 36px rgba(15,23,42,.08)',
        }}
      >
        <header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 20,
            borderBottom: '1px solid #e2e8f0',
            paddingBottom: 18,
          }}
        >
          <div>
            <div style={{ color: '#64748b' }}>KirinDesk Secure Document</div>
            <h1 style={{ margin: '6px 0' }}>{data.document_type.toUpperCase()}</h1>
            <strong>
              {data.document.quote_number} · v{data.document.source_version}
            </strong>
          </div>
          <span
            style={{
              alignSelf: 'start',
              background: data.confirmed_at ? '#ecfdf3' : '#eff6ff',
              color: data.confirmed_at ? '#067647' : '#175cd3',
              padding: '8px 12px',
              borderRadius: 999,
            }}
          >
            {data.confirmed_at
              ? labels.confirmed
              : data.document.status === 'draft'
                ? 'DRAFT'
                : 'LOCKED'}
          </span>
        </header>
        <section
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, margin: '24px 0' }}
        >
          <div>
            <div style={{ color: '#64748b' }}>{labels.customer}</div>
            <strong>{data.document.customer?.company_name ?? '-'}</strong>
          </div>
          <div>
            <div style={{ color: '#64748b' }}>{labels.amount}</div>
            <strong>
              {data.document.pricing_currency} {data.document.totals.grand_total}
            </strong>
          </div>
          <div>
            <div style={{ color: '#64748b' }}>Incoterm</div>
            <strong>{data.document.incoterm}</strong>
          </div>
          <div>
            <div style={{ color: '#64748b' }}>Language</div>
            <strong>{data.document.language.toUpperCase()}</strong>
          </div>
        </section>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#f1f5f9' }}>
              <th style={{ padding: 10, textAlign: 'start' }}>SKU</th>
              <th style={{ padding: 10, textAlign: 'start' }}>Product</th>
              <th style={{ padding: 10 }}>Qty</th>
              <th style={{ padding: 10 }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.document.lines.map((line) => (
              <tr key={line.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={{ padding: 10 }}>{line.sku}</td>
                <td style={{ padding: 10 }}>{line.name}</td>
                <td style={{ padding: 10, textAlign: 'center' }}>
                  {line.quantity} {line.unit}
                </td>
                <td style={{ padding: 10, textAlign: 'center' }}>
                  {data.document.pricing_currency} {line.line_total}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {error && (
          <p role="alert" style={{ color: '#b42318' }}>
            {error}
          </p>
        )}
        <footer style={{ display: 'flex', gap: 12, marginTop: 26, flexWrap: 'wrap' }}>
          <a
            href={data.download_path}
            style={{
              background: data.document.theme_color,
              color: 'white',
              padding: '11px 16px',
              borderRadius: 8,
              textDecoration: 'none',
            }}
          >
            {labels.download}
          </a>
          <button
            type="button"
            disabled={Boolean(data.confirmed_at) || confirming}
            onClick={() => void confirm()}
            style={{ padding: '10px 16px' }}
          >
            {data.confirmed_at ? labels.confirmed : confirming ? '…' : labels.confirm}
          </button>
        </footer>
      </article>
    </main>
  );
}
