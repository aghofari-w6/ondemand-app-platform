import logistics from '@aod/template-logistics';
import ordering from '@aod/template-ordering';
import payments from '@aod/template-payments';
import pos from '@aod/template-pos';
import type { TemplateModule } from '@aod/shared';

/** The platform's template registry. Templates never import each other. */
export const TEMPLATES: TemplateModule[] = [ordering, payments, pos, logistics];
