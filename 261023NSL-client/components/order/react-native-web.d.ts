import "react-native-web";
import type {
  ViewStyle as NativeViewStyle,
  TextStyle as NativeTextStyle,
  ImageStyle as NativeImageStyle,
  StyleProp as NativeStyleProp,
} from "react-native";
import type { AriaRole } from "react";

// @types/react-native-web publishes StyleSheet as a type-only alias, while
// react-native-web exports the runtime object used by these native components.
declare module "react-native-web" {
  export interface ViewProps {
    role?: AriaRole;
  }
  export const StyleSheet: {
    create<
      T extends Record<
        string,
        NativeViewStyle | NativeTextStyle | NativeImageStyle
      >,
    >(
      styles: T,
    ): T;
    absoluteFillObject: NativeViewStyle;
    flatten(
      style: NativeStyleProp<NativeViewStyle>,
    ): NativeViewStyle | undefined;
  };
}
