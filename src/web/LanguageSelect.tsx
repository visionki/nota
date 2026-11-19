import { Languages } from 'lucide-react';
import { setLanguage, translate, useLanguage, type LanguagePreference } from './locale';

export function LanguageSelect() {
  const { preference } = useLanguage();
  return (
    <label className="language-select">
      <Languages aria-hidden="true" size={16} />
      <select
        aria-label={translate('界面语言')}
        value={preference}
        onChange={(event) => setLanguage(event.currentTarget.value as LanguagePreference)}
      >
        <option value="auto">{translate('跟随浏览器')}</option>
        <option value="en" lang="en">
          English
        </option>
        <option value="zh-CN" lang="zh-CN">
          简体中文
        </option>
      </select>
    </label>
  );
}
