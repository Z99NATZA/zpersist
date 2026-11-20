import type { Problem } from './api';
import { useI18n } from './i18n';

export function ErrorNotice({ problem, className = '' }: { problem: Problem; className?: string }) {
  const { t, errorText } = useI18n();
  return (
    <div className={`notice ${className}`}>
      <p role="alert">{errorText(problem)}</p>
      {problem.detail && (
        <details className="error-details">
          <summary>{t('details')}</summary>
          <p>{problem.detail}</p>
        </details>
      )}
    </div>
  );
}
