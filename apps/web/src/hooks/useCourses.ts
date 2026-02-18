import { useQuery } from "@tanstack/react-query";
import type { Course } from "@swng/domain";
import { client } from "../lib/client";

export function useCourses() {
  const { data, isLoading, error } = useQuery<Course[]>({
    queryKey: ["courses"],
    queryFn: async () => {
      const { courses } = await client.listCourses();
      return courses;
    },
    staleTime: 5 * 60 * 1000,
  });

  return { courses: data ?? [], isLoading, error };
}
