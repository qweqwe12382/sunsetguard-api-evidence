// Original fixture data for static scanning. Do not install or execute it.
import { oldApi as legacy, oldApi as unused, type oldApi as LegacyType } from "example-lib";
import * as api from "example-lib";

legacy();
type Options = LegacyType;
api.oldApi();
export { oldApi as forwarded } from "example-lib";

function shadow(legacy: () => void) {
  legacy(); // Refers to the parameter, not the imported binding.
}
