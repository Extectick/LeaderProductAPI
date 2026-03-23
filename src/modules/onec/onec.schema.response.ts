import { ONEC_SCHEMA_VERSION, onecSchemaEntities } from './onec.schema';

export const onecSchemaResponse = {
  success: true,
  version: ONEC_SCHEMA_VERSION,
  entities: onecSchemaEntities,
} as const;
